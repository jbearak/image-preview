'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const manifest = require('../package.json');
const { loadExtension } = require('./load-extension');

const { ImagePreviewProvider, getSupportedFormat } = loadExtension({});

function getPreviewHtml(format = 'svg') {
    const provider = Object.create(ImagePreviewProvider.prototype);
    provider.getImageUri = () => `webview://preview/image.${format}`;
    return provider.getHtml({
        document: {
            format: getSupportedFormat({ path: `/image.${format}` })
        },
        panel: {
            webview: {
                cspSource: 'webview-source'
            }
        }
    });
}

function createEventTarget(properties = {}) {
    const listeners = new Map();
    return Object.assign(properties, {
        addEventListener(type, listener) {
            const registered = listeners.get(type) ?? [];
            registered.push(listener);
            listeners.set(type, registered);
        },
        dispatch(type, event = {}) {
            for (const listener of listeners.get(type) ?? []) {
                listener(event);
            }
        }
    });
}

function createClassList() {
    const values = new Set();
    return {
        add(...names) {
            names.forEach(name => values.add(name));
        },
        remove(...names) {
            names.forEach(name => values.delete(name));
        },
        contains(name) {
            return values.has(name);
        },
        toggle(name, force) {
            if (force) {
                values.add(name);
            } else {
                values.delete(name);
            }
        }
    };
}

function runPreviewScript({
    fetchOk = true,
    format = 'svg',
    imageReady = true,
    imageWidth = 100,
    imageHeight = 50,
    sourceBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    sourceType = 'image/png',
    storedState
} = {}) {
    const html = getPreviewHtml(format);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    const messages = [];
    const clipboardWrites = [];
    const drawCalls = [];
    const fetchCalls = [];
    let canvasCreations = 0;
    const body = { classList: createClassList() };
    const viewport = { width: 800, height: 600 };
    const previewCanvas = { style: {} };
    const imageSrc = `webview://preview/image.${format}`;
    const image = createEventTarget({
        complete: imageReady,
        currentSrc: imageSrc,
        naturalWidth: imageReady ? imageWidth : 0,
        naturalHeight: imageReady ? imageHeight : 0,
        clientWidth: imageWidth,
        clientHeight: imageHeight,
        src: imageSrc,
        style: {},
        focus() {},
        getBoundingClientRect() {
            return { left: 10, top: 20, width: 100, height: 50 };
        }
    });
    let document;
    function createMenuButton(label) {
        return createEventTarget({
            label,
            attributes: {},
            focus() {
                document.activeElement = this;
            },
            setAttribute(name, value) {
                this.attributes[name] = value;
            }
        });
    }
    const copyButton = createMenuButton('Copy');
    const zoomButtons = Array.from(
        html.matchAll(/<button type="button" role="menuitemradio"[^>]*>([^<]+)<\/button>/g),
        ([, label]) => createMenuButton(label)
    );
    const menuButtons = [copyButton, ...zoomButtons];
    const contextMenu = createEventTarget({
        classList: createClassList(),
        hidden: true,
        style: {},
        querySelectorAll() {
            return menuButtons;
        },
        contains(target) {
            return target === contextMenu || menuButtons.includes(target);
        },
        getBoundingClientRect() {
            return { width: 120, height: 24 };
        }
    });
    document = createEventTarget({
        body,
        activeElement: null,
        getElementById(id) {
            return { canvas: previewCanvas, image, 'context-menu': contextMenu }[id];
        },
        createElement(tag) {
            assert.equal(tag, 'canvas');
            canvasCreations += 1;
            return {
                width: 0,
                height: 0,
                getContext() {
                    return {
                        drawImage(...args) {
                            drawCalls.push(args);
                        }
                    };
                },
                toBlob(callback) {
                    callback(new Blob(['rendered'], { type: 'image/png' }));
                }
            };
        }
    });
    const window = createEventTarget({
        getSelection() {
            return { isCollapsed: true };
        }
    });

    class ClipboardItem {
        constructor(data) {
            this.data = data;
        }
    }

    vm.runInNewContext(script, {
        acquireVsCodeApi() {
            return {
                getState() {
                    return storedState;
                },
                setState() {},
                postMessage(message) {
                    messages.push(message);
                }
            };
        },
        Blob,
        ClipboardItem,
        console: { error() {} },
        devicePixelRatio: 2,
        document,
        async fetch(url) {
            fetchCalls.push(url);
            return {
                ok: fetchOk,
                async blob() {
                    return new Blob([sourceBytes], { type: sourceType });
                }
            };
        },
        get innerHeight() {
            return viewport.height;
        },
        get innerWidth() {
            return viewport.width;
        },
        navigator: {
            clipboard: {
                async write(items) {
                    await Promise.all(Object.values(items[0].data));
                    clipboardWrites.push(items);
                }
            }
        },
        setTimeout,
        window
    });

    return {
        body,
        get canvasCreations() {
            return canvasCreations;
        },
        clipboardWrites,
        contextMenu,
        copyButton,
        zoomButtons,
        document,
        drawCalls,
        fetchCalls,
        image,
        messages,
        previewCanvas,
        viewport,
        window
    };
}

async function flushCopy() {
    await new Promise(resolve => setImmediate(resolve));
}

test('places zoom levels below Copy in the custom menu', () => {
    assert.equal(manifest.contributes.menus['webview/context'], undefined);
    const html = getPreviewHtml();

    assert.equal(html.match(/role="menuitem"/g)?.length, 1);
    assert.match(html, />Copy<\/button>[\s\S]*?>Fit<\/button>[\s\S]*?>Fit Width<\/button>[\s\S]*?>Actual Size<\/button>/);
    assert.match(html, />10%<\/button>/);
    assert.match(html, />1000%<\/button>/);
    assert.doesNotMatch(html, />Cut<|>Paste</);
});

test('keeps the context menu compact and highlights keyboard focus only during keyboard navigation', () => {
    const html = getPreviewHtml();
    const menuRule = html.match(/#context-menu \{([\s\S]*?)\}/)[1];
    const buttonRule = html.match(/#context-menu button \{([\s\S]*?)\}/)[1];

    assert.match(menuRule, /width: 160px/);
    assert.match(menuRule, /max-width: calc\(100vw - 8px\)/);
    assert.match(buttonRule, /box-sizing: border-box/);
    assert.match(html, /#context-menu\.keyboard-navigation button:focus/);
    assert.doesNotMatch(html, /#context-menu button:focus \{/);
});

test('limits webview connections to its resource source', () => {
    const html = getPreviewHtml('png');
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];

    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src webview-source/);
    assert.match(csp, /connect-src webview-source/);
    assert.doesNotMatch(csp, /connect-src \*/);
    assert.doesNotMatch(csp, /https:|http:|data:|blob:/);
});

test('shows format-specific load errors', () => {
    assert.match(getPreviewHtml('svg'), /Unable to load the SVG\./);
    assert.match(getPreviewHtml('png'), /Unable to load the PNG\./);
});

test('provides a width-only Fit Width layout', () => {
    const html = getPreviewHtml();
    const pageRule = html.match(/html, body \{([\s\S]*?)\}/)[1];
    const imageRule = html.match(/\n        #image \{([\s\S]*?)\}/)[1];
    const fitWidthCanvasRule = html.match(/body\.fit-width #canvas \{([\s\S]*?)\}/)[1];
    const fitWidthRule = html.match(/body\.fit-width #image \{([\s\S]*?)\}/)[1];

    assert.match(pageRule, /padding: 0/);
    assert.match(imageRule, /max-width: none/);
    assert.match(imageRule, /max-height: none/);
    assert.match(fitWidthCanvasRule, /width: 100%/);
    assert.match(fitWidthRule, /width: 100%/);
    assert.doesNotMatch(fitWidthRule, /max-height/);
});

test('switches between Fit, Fit Width, and numeric zoom layouts', () => {
    const preview = runPreviewScript();

    preview.window.dispatch('message', { data: { type: 'setZoom', zoom: 2 } });
    assert.equal(preview.body.classList.contains('numeric-zoom'), true);
    assert.equal(preview.image.style.height, '100px');

    preview.window.dispatch('message', { data: { type: 'setZoom', zoom: 'fit' } });
    assert.equal(preview.body.classList.contains('fit'), true);
    assert.equal(preview.body.classList.contains('fit-width'), false);
    assert.equal(preview.body.classList.contains('numeric-zoom'), false);
    assert.equal(preview.image.style.height, '400px');

    preview.window.dispatch('message', { data: { type: 'setZoom', zoom: 'fitWidth' } });
    assert.equal(preview.body.classList.contains('fit'), false);
    assert.equal(preview.body.classList.contains('fit-width'), true);
    assert.equal(preview.body.classList.contains('numeric-zoom'), false);
    assert.equal(preview.previewCanvas.style.height, '');
    assert.equal(preview.image.style.height, '');
});

test('Fit expands a small image to the largest size inside the viewport', () => {
    const preview = runPreviewScript();

    preview.image.dispatch('load');

    assert.equal(preview.image.style.width, '800px');
    assert.equal(preview.image.style.height, '400px');
});

test('Fit shrinks a large image without changing its aspect ratio', () => {
    const preview = runPreviewScript({ imageWidth: 1600, imageHeight: 800 });

    preview.image.dispatch('load');

    assert.equal(preview.image.style.width, '800px');
    assert.equal(preview.image.style.height, '400px');
});

test('Fit uses viewport height for tall images and updates on resize', () => {
    const preview = runPreviewScript({ imageWidth: 100, imageHeight: 200 });
    preview.image.dispatch('load');

    assert.equal(preview.image.style.width, '300px');
    assert.equal(preview.image.style.height, '600px');

    preview.viewport.width = 200;
    preview.window.dispatch('resize');

    assert.equal(preview.image.style.width, '200px');
    assert.equal(preview.image.style.height, '400px');
});

test('restores Fit as a persisted zoom mode', () => {
    const preview = runPreviewScript({ storedState: { zoom: 'fit' } });

    preview.image.dispatch('load');

    assert.equal(preview.body.classList.contains('fit'), true);
    assert.equal(preview.messages.at(-1).type, 'ready');
    assert.equal(preview.messages.at(-1).dimensions, '100x50');
    assert.equal(preview.messages.at(-1).zoom, 'fit');
});

test('suppresses native edit actions while the preview is unavailable', () => {
    const preview = runPreviewScript({ imageReady: false });
    let prevented = false;

    preview.document.dispatch('contextmenu', {
        preventDefault() {
            prevented = true;
        },
        target: preview.image
    });

    assert.equal(prevented, true);
    assert.equal(preview.contextMenu.hidden, true);
});

test('navigates the context menu with arrow and boundary keys', () => {
    const preview = runPreviewScript();
    preview.document.dispatch('contextmenu', {
        clientX: 40,
        clientY: 50,
        preventDefault() {},
        target: preview.image
    });
    let prevented = false;

    preview.document.dispatch('keydown', {
        key: 'ArrowDown',
        preventDefault() {
            prevented = true;
        }
    });
    assert.equal(prevented, true);
    assert.equal(preview.contextMenu.hidden, false);
    assert.equal(preview.document.activeElement, preview.zoomButtons[0]);
    assert.equal(preview.contextMenu.classList.contains('keyboard-navigation'), true);

    preview.contextMenu.dispatch('pointermove');
    assert.equal(preview.contextMenu.classList.contains('keyboard-navigation'), false);

    preview.document.dispatch('keydown', { key: 'End', preventDefault() {} });
    assert.equal(preview.document.activeElement, preview.zoomButtons.at(-1));
    assert.equal(preview.contextMenu.classList.contains('keyboard-navigation'), true);
    preview.document.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
    assert.equal(preview.document.activeElement, preview.copyButton);

    preview.document.dispatch('keydown', { key: 'Tab' });
    assert.equal(preview.contextMenu.hidden, true);
});

test('scrolling zoom levels keeps the menu open while preview scrolling closes it', () => {
    const preview = runPreviewScript();
    preview.document.dispatch('contextmenu', {
        clientX: 40,
        clientY: 50,
        preventDefault() {},
        target: preview.image
    });

    preview.window.dispatch('scroll', { target: preview.contextMenu });
    assert.equal(preview.contextMenu.hidden, false);

    preview.window.dispatch('scroll', { target: preview.previewCanvas });
    assert.equal(preview.contextMenu.hidden, true);
});

test('context menu zoom levels apply and report the selected scale', () => {
    const preview = runPreviewScript();
    preview.image.dispatch('load');
    preview.document.dispatch('contextmenu', {
        clientX: 40,
        clientY: 50,
        preventDefault() {},
        target: preview.image
    });

    const actualSize = preview.zoomButtons.find(button => button.label === 'Actual Size');
    actualSize.dispatch('click');

    assert.equal(preview.contextMenu.hidden, true);
    assert.equal(preview.body.classList.contains('numeric-zoom'), true);
    assert.equal(preview.image.style.width, '100px');
    assert.equal(actualSize.attributes['aria-checked'], 'true');
    assert.equal(preview.messages.at(-1).type, 'zoom');
    assert.equal(preview.messages.at(-1).zoom, 1);

    preview.document.dispatch('contextmenu', {
        clientX: 40,
        clientY: 50,
        preventDefault() {},
        target: preview.image
    });
    preview.zoomButtons.find(button => button.label === 'Fit').dispatch('click');
    assert.equal(preview.image.style.width, '800px');
    assert.equal(preview.image.style.height, '400px');
    assert.equal(preview.messages.at(-1).zoom, 'fit');
});

test('copies SVG from the rendered canvas', async () => {
    const preview = runPreviewScript({ format: 'svg' });
    let prevented = false;

    preview.document.dispatch('contextmenu', {
        clientX: 40,
        clientY: 50,
        preventDefault() {
            prevented = true;
        },
        target: preview.image
    });
    assert.equal(prevented, true);
    assert.equal(preview.contextMenu.hidden, false);

    preview.copyButton.dispatch('click');
    await flushCopy();

    assert.equal(preview.clipboardWrites.length, 1);
    const item = preview.clipboardWrites[0][0];
    assert.equal((await item.data['image/png']).type, 'image/png');
    assert.equal(preview.canvasCreations, 1);
    assert.equal(preview.drawCalls.length, 1);
    assert.deepEqual(preview.drawCalls[0].slice(1), [0, 0, 200, 100]);
    assert.deepEqual(preview.fetchCalls, []);
});

test('copies the original PNG payload without rasterizing it', async () => {
    const sourceBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);
    const preview = runPreviewScript({ format: 'png', sourceBytes });

    preview.copyButton.dispatch('click');
    await flushCopy();

    assert.deepEqual(preview.fetchCalls, ['webview://preview/image.png']);
    assert.equal(preview.clipboardWrites.length, 1);
    const blob = await preview.clipboardWrites[0][0].data['image/png'];
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), sourceBytes);
    assert.equal(preview.canvasCreations, 0);
    assert.deepEqual(preview.drawCalls, []);
    assert.equal(preview.messages.some(message => message.type === 'copyDownscaled'), false);
});

test('normalizes PNG clipboard type without changing its bytes', async () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    const preview = runPreviewScript({
        format: 'png',
        sourceBytes,
        sourceType: 'application/octet-stream'
    });

    preview.copyButton.dispatch('click');
    await flushCopy();

    const blob = await preview.clipboardWrites[0][0].data['image/png'];
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), sourceBytes);
});

test('reports PNG fetch failures without falling back to canvas', async () => {
    const preview = runPreviewScript({ fetchOk: false, format: 'png' });

    preview.copyButton.dispatch('click');
    await flushCopy();

    assert.equal(preview.clipboardWrites.length, 0);
    assert.equal(preview.canvasCreations, 0);
    assert.equal(preview.messages.filter(message => message.type === 'copyError').length, 1);
    assert.equal(preview.messages.some(message => message.type === 'copyDownscaled'), false);
});
