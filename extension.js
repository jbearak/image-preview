// @ts-check
'use strict';

const vscode = require('vscode');

const VIEW_TYPE = 'jbearak.imagePreview';
const COPY_DOWNSCALED_MESSAGE = 'The SVG was copied at a reduced resolution because its rendered size is too large.';
const DEFAULT_ZOOM = 'fit';
/** @typedef {{ extension: string, filenamePattern: string, label: string, mediaType: string, copyStrategy: 'rasterize' | 'source' }} ImageFormat */
/** @type {readonly ImageFormat[]} */
const SUPPORTED_FORMATS = Object.freeze([
    Object.freeze({
        extension: 'svg',
        filenamePattern: '*.[sS][vV][gG]',
        label: 'SVG',
        mediaType: 'image/svg+xml',
        copyStrategy: 'rasterize'
    }),
    Object.freeze({
        extension: 'png',
        filenamePattern: '*.[pP][nN][gG]',
        label: 'PNG',
        mediaType: 'image/png',
        copyStrategy: 'source'
    })
]);
/** @type {Record<string, string>} */
const ZOOM_MODE_LABELS = {
    fit: 'Fit',
    fitWidth: 'Fit Width'
};
const ZOOM_LEVELS = [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];
const ZOOM_CHOICES = [
    ...Object.entries(ZOOM_MODE_LABELS).map(([zoom, label]) => ({ label, zoom })),
    { label: 'Actual Size', zoom: 1 },
    ...ZOOM_LEVELS
        .filter(level => level !== 1)
        .map(level => ({ label: `${Math.round(level * 100)}%`, zoom: level }))
];

class ImagePreviewProvider {
    /** @param {vscode.ExtensionContext} context */
    constructor(context) {
        this.context = context;
        this.previews = new Set();
        this.activePreview = undefined;

        this.zoomStatus = vscode.window.createStatusBarItem(
            'imagePreview.zoom',
            vscode.StatusBarAlignment.Right,
            102
        );
        this.zoomStatus.name = 'SVG & PNG Preview Zoom';
        this.zoomStatus.command = 'imagePreview.selectZoom';

        this.dimensionsStatus = vscode.window.createStatusBarItem(
            'imagePreview.dimensions',
            vscode.StatusBarAlignment.Right,
            101
        );
        this.dimensionsStatus.name = 'Image Dimensions';

        this.fileSizeStatus = vscode.window.createStatusBarItem(
            'imagePreview.fileSize',
            vscode.StatusBarAlignment.Right,
            100
        );
        this.fileSizeStatus.name = 'Image File Size';

        context.subscriptions.push(
            this.zoomStatus,
            this.dimensionsStatus,
            this.fileSizeStatus
        );
    }

    /** @param {vscode.Uri} uri */
    async openCustomDocument(uri) {
        const format = getSupportedFormat(uri);
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*')
        );
        watcher.onDidChange(changedUri => this.refresh(changedUri));
        watcher.onDidCreate(changedUri => this.refresh(changedUri));
        watcher.onDidDelete(changedUri => this.refresh(changedUri));

        return {
            uri,
            format,
            dispose() {
                watcher.dispose();
            }
        };
    }

    /**
     * @param {{ uri: vscode.Uri, format: ImageFormat }} document
     * @param {vscode.WebviewPanel} panel
     */
    async resolveCustomEditor(document, panel) {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(document.uri, '..')]
        };

        const preview = {
            document,
            panel,
            zoom: DEFAULT_ZOOM,
            dimensions: '',
            fileSize: ''
        };

        this.previews.add(preview);
        panel.webview.html = this.getHtml(preview);

        panel.webview.onDidReceiveMessage(message => {
            if (message.type === 'ready') {
                preview.dimensions = message.dimensions;
                preview.zoom = message.zoom;
                this.updateStatus(preview);
            } else if (message.type === 'zoom') {
                preview.zoom = message.zoom;
                this.updateStatus(preview);
            } else if (message.type === 'dimensions') {
                preview.dimensions = message.dimensions;
                this.updateStatus(preview);
            } else if (message.type === 'copyError') {
                vscode.window.showErrorMessage(
                    `Unable to copy the ${preview.document.format.label} preview to the clipboard.`
                );
            } else if (message.type === 'copyDownscaled') {
                vscode.window.showWarningMessage(COPY_DOWNSCALED_MESSAGE);
            }
        });

        panel.onDidChangeViewState(() => {
            if (panel.active) {
                this.setActivePreview(preview);
            } else if (this.activePreview === preview) {
                this.setActivePreview(undefined);
            }
        });

        panel.onDidDispose(() => {
            this.previews.delete(preview);
            if (this.activePreview === preview) {
                this.setActivePreview(undefined);
            }
        });

        if (panel.active) {
            this.setActivePreview(preview);
        }

        void this.updateFileSize(preview);
    }

    /** @param {vscode.Uri} uri */
    async refresh(uri) {
        for (const preview of this.previews) {
            if (preview.document.uri.toString() !== uri.toString()) {
                continue;
            }

            await this.updateFileSize(preview);
            preview.panel.webview.postMessage({
                type: 'reload',
                src: this.getImageUri(preview, Date.now())
            });
        }
    }

    /** @param {any} preview */
    async updateFileSize(preview) {
        try {
            const stat = await vscode.workspace.fs.stat(preview.document.uri);
            preview.fileSize = formatFileSize(stat.size);
        } catch {
            preview.fileSize = '';
        }
        this.updateStatus(preview);
    }

    /** @param {any | undefined} preview */
    setActivePreview(preview) {
        this.activePreview = preview;
        if (preview) {
            this.updateStatus(preview);
        } else {
            this.zoomStatus.hide();
            this.dimensionsStatus.hide();
            this.fileSizeStatus.hide();
        }
    }

    /** @param {any} preview */
    updateStatus(preview) {
        if (this.activePreview !== preview || !preview.panel.active) {
            return;
        }

        this.zoomStatus.text = zoomLabel(preview.zoom);
        this.dimensionsStatus.text = preview.dimensions;
        this.fileSizeStatus.text = preview.fileSize;
        this.zoomStatus.show();
        this.dimensionsStatus.show();
        this.fileSizeStatus.show();
    }

    async selectZoom() {
        const preview = this.activePreview;
        if (!preview) {
            return;
        }

        const choice = await vscode.window.showQuickPick(ZOOM_CHOICES, {
            placeHolder: 'Select image zoom level'
        });
        if (choice) {
            this.setZoom(preview, choice.zoom);
        }
    }

    zoomIn() {
        if (this.activePreview) {
            this.activePreview.panel.webview.postMessage({ type: 'zoomIn' });
        }
    }

    zoomOut() {
        if (this.activePreview) {
            this.activePreview.panel.webview.postMessage({ type: 'zoomOut' });
        }
    }

    /** @param {any} preview @param {string | number} zoom */
    setZoom(preview, zoom) {
        preview.zoom = zoom;
        preview.panel.webview.postMessage({ type: 'setZoom', zoom });
        this.updateStatus(preview);
    }

    /** @param {any} preview @param {number} version */
    getImageUri(preview, version) {
        const resource = preview.panel.webview.asWebviewUri(preview.document.uri);
        const separator = resource.query ? '&' : '';
        return resource.with({ query: `${resource.query}${separator}v=${version}` }).toString();
    }

    /** @param {any} preview */
    getHtml(preview) {
        const nonce = createNonce();
        const src = this.getImageUri(preview, Date.now());
        const cspSource = preview.panel.webview.cspSource;
        const format = preview.document.format;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; connect-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
        html, body {
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 0;
            background: var(--vscode-editor-background);
            overflow: auto;
        }
        body {
            display: flex;
            box-sizing: border-box;
        }
        #canvas {
            min-width: 100%;
            min-height: 100%;
            display: flex;
            justify-content: flex-start;
            align-items: flex-start;
            box-sizing: border-box;
        }
        body.numeric-zoom #canvas {
            flex: none;
        }
        #image {
            display: block;
            flex: none;
            max-width: none;
            max-height: none;
            margin: auto;
        }
        body.fit-width #canvas {
            width: 100%;
        }
        body.fit-width #image {
            width: 100%;
        }
        #error {
            display: none;
            margin: auto;
            color: var(--vscode-errorForeground);
            font-family: var(--vscode-font-family);
        }
        body.error #canvas {
            display: none;
        }
        body.error #error {
            display: block;
        }
        #context-menu {
            position: fixed;
            z-index: 1;
            width: 160px;
            max-width: calc(100vw - 8px);
            max-height: calc(100vh - 8px);
            overflow-y: auto;
            box-sizing: border-box;
            padding: 4px;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            box-shadow: 0 2px 8px var(--vscode-widget-shadow);
            font-family: var(--vscode-font-family);
        }
        #context-menu button {
            width: 100%;
            box-sizing: border-box;
            padding: 4px 20px;
            color: var(--vscode-menu-foreground);
            background: transparent;
            border: 0;
            font: inherit;
            text-align: left;
        }
        #context-menu button:first-child {
            border-bottom: 1px solid var(--vscode-menu-border);
            margin-bottom: 4px;
            padding-bottom: 8px;
        }
        #context-menu button:hover,
        #context-menu.keyboard-navigation button:focus {
            color: var(--vscode-menu-selectionForeground);
            background: var(--vscode-menu-selectionBackground);
            outline: none;
        }
    </style>
</head>
<body class="fit">
    <div id="canvas"><img id="image" src="${escapeHtml(src)}" crossorigin="anonymous" tabindex="0" alt=""></div>
    <div id="error">Unable to load the ${escapeHtml(format.label)}.</div>
    <div id="context-menu" role="menu" hidden>
        <button type="button" role="menuitem">Copy</button>
        ${ZOOM_CHOICES.map(choice => `<button type="button" role="menuitemradio" aria-checked="false">${escapeHtml(choice.label)}</button>`).join('\n        ')}
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const canvas = document.getElementById('canvas');
        const image = document.getElementById('image');
        const contextMenu = document.getElementById('context-menu');
        const menuButtons = Array.from(contextMenu.querySelectorAll('button'));
        const copyButton = menuButtons[0];
        const zoomButtons = menuButtons.slice(1);
        const zoomChoices = ${JSON.stringify(ZOOM_CHOICES)};
        const format = ${JSON.stringify({
            copyStrategy: format.copyStrategy,
            label: format.label,
            mediaType: format.mediaType
        })};
        const levels = ${JSON.stringify(ZOOM_LEVELS)};
        ${numericZoomLayout.toString()}
        ${rasterLayout.toString()}
        let zoom = vscode.getState()?.zoom ?? ${JSON.stringify(DEFAULT_ZOOM)};
        let copyInFlight = false;

        function isImageReady() {
            return image.complete && image.naturalWidth && image.naturalHeight;
        }

        function labelDimensions() {
            return image.naturalWidth + 'x' + image.naturalHeight;
        }

        function numericZoom() {
            if (typeof zoom === 'number') {
                return zoom;
            }
            if (!image.naturalWidth) {
                return 1;
            }
            return image.clientWidth / image.naturalWidth;
        }

        function applyZoom(nextZoom, report = true) {
            zoom = nextZoom;
            const isFit = zoom === 'fit';
            const isFitWidth = zoom === 'fitWidth';
            document.body.classList.toggle('fit', isFit);
            document.body.classList.toggle('fit-width', isFitWidth);
            document.body.classList.toggle('numeric-zoom', !isFit && !isFitWidth);
            canvas.style.width = '';
            canvas.style.height = '';
            image.style.width = '';
            image.style.height = '';

            if (isFit && image.naturalWidth && image.naturalHeight) {
                const scale = Math.min(innerWidth / image.naturalWidth, innerHeight / image.naturalHeight);
                image.style.width = Math.min(innerWidth, Math.round(image.naturalWidth * scale)) + 'px';
                image.style.height = Math.min(innerHeight, Math.round(image.naturalHeight * scale)) + 'px';
            } else if (!isFit && !isFitWidth) {
                const width = image.naturalWidth || image.clientWidth || 1;
                const height = image.naturalHeight || image.clientHeight || 1;
                const layout = numericZoomLayout(width, height, zoom);
                image.style.width = layout.imageWidth;
                image.style.height = layout.imageHeight;
                canvas.style.width = layout.canvasWidth;
                canvas.style.height = layout.canvasHeight;
            }

            zoomButtons.forEach((button, index) => {
                button.setAttribute('aria-checked', String(zoomChoices[index].zoom === zoom));
            });

            vscode.setState({ zoom });
            if (report) {
                vscode.postMessage({ type: 'zoom', zoom });
            }
        }

        function stepZoom(direction) {
            const current = numericZoom();
            const choices = direction > 0 ? levels : [...levels].reverse();
            const next = choices.find(level => direction > 0 ? level > current + 0.001 : level < current - 0.001);
            applyZoom(next ?? (direction > 0 ? levels.at(-1) : levels[0]));
        }

        function rasterizeImage(layout) {
            const canvas = document.createElement('canvas');
            canvas.width = layout.width;
            canvas.height = layout.height;
            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error('Unable to create a canvas context');
            }
            context.drawImage(image, 0, 0, layout.width, layout.height);
            return new Promise((resolve, reject) => {
                canvas.toBlob(blob => {
                    canvas.width = 0;
                    canvas.height = 0;
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Unable to encode the image as PNG'));
                    }
                }, 'image/png');
            });
        }

        async function originalImageBlob() {
            const response = await fetch(image.currentSrc || image.src);
            if (!response.ok) {
                throw new Error('Unable to read the original ' + format.label);
            }
            const blob = await response.blob();
            return blob.type === format.mediaType
                ? blob
                : new Blob([blob], { type: format.mediaType });
        }

        async function copyImage() {
            if (copyInFlight) {
                return;
            }
            copyInFlight = true;

            try {
                if (!isImageReady()) {
                    throw new Error('The image is not loaded');
                }
                if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
                    throw new Error('Image clipboard writes are not supported');
                }

                let payload;
                let downscaled = false;
                if (format.copyStrategy === 'source') {
                    payload = originalImageBlob();
                } else {
                    const bounds = image.getBoundingClientRect();
                    const layout = rasterLayout(
                        image.naturalWidth,
                        image.naturalHeight,
                        bounds.width,
                        bounds.height,
                        devicePixelRatio
                    );
                    payload = rasterizeImage(layout);
                    downscaled = layout.downscaled;
                }

                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': payload })
                ]);
                if (downscaled) {
                    vscode.postMessage({ type: 'copyDownscaled' });
                }
            } catch (error) {
                console.error('Unable to copy image preview', error);
                vscode.postMessage({ type: 'copyError' });
            } finally {
                copyInFlight = false;
            }
        }

        image.addEventListener('load', () => {
            document.body.classList.remove('error');
            applyZoom(zoom, false);
            vscode.postMessage({
                type: 'ready',
                dimensions: labelDimensions(),
                zoom
            });
        });

        image.addEventListener('error', () => {
            document.body.classList.add('error');
        });

        let contextMenuInvoker;

        function hideContextMenu(restoreFocus = false) {
            contextMenu.hidden = true;
            if (restoreFocus) {
                contextMenuInvoker?.focus?.();
            }
            contextMenuInvoker = undefined;
        }

        document.addEventListener('contextmenu', event => {
            event.preventDefault();
            if (!isImageReady()) {
                hideContextMenu();
                return;
            }
            contextMenuInvoker = event.target;
            contextMenu.classList.toggle('keyboard-navigation', !event.clientX && !event.clientY);
            contextMenu.hidden = false;

            const menuBounds = contextMenu.getBoundingClientRect();
            let x = event.clientX;
            let y = event.clientY;
            if (!x && !y) {
                const imageBounds = image.getBoundingClientRect();
                x = imageBounds.left + 16;
                y = imageBounds.top + 16;
            }
            contextMenu.style.left = Math.max(0, Math.min(x, innerWidth - menuBounds.width)) + 'px';
            contextMenu.style.top = Math.max(0, Math.min(y, innerHeight - menuBounds.height)) + 'px';
            copyButton.focus();
        });

        copyButton.addEventListener('click', () => {
            hideContextMenu(true);
            copyImage();
        });

        zoomButtons.forEach((button, index) => {
            button.addEventListener('click', () => {
                hideContextMenu(true);
                applyZoom(zoomChoices[index].zoom);
            });
        });

        document.addEventListener('pointerdown', event => {
            if (!contextMenu.contains(event.target)) {
                hideContextMenu();
            }
        }, true);

        contextMenu.addEventListener('pointermove', () => {
            contextMenu.classList.remove('keyboard-navigation');
        });

        document.addEventListener('keydown', event => {
            if (contextMenu.hidden) {
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                hideContextMenu(true);
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                contextMenu.classList.add('keyboard-navigation');
                const index = menuButtons.indexOf(document.activeElement);
                const next = event.key === 'Home' ? 0
                    : event.key === 'End' ? menuButtons.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : menuButtons.length - 1)) % menuButtons.length;
                menuButtons[next].focus();
            } else if (event.key === 'Tab') {
                hideContextMenu();
            }
        });

        contextMenu.addEventListener('focusout', event => {
            if (!contextMenu.contains(event.relatedTarget)) {
                hideContextMenu();
            }
        });

        document.addEventListener('copy', event => {
            const selection = window.getSelection();
            if (!isImageReady() || selection && !selection.isCollapsed) {
                return;
            }
            event.preventDefault();
            copyImage();
        });

        window.addEventListener('blur', () => hideContextMenu());
        window.addEventListener('scroll', event => {
            if (!contextMenu.contains(event.target)) {
                hideContextMenu();
            }
        }, true);
        window.addEventListener('resize', () => {
            if (zoom === 'fit') {
                applyZoom(zoom, false);
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'setZoom') {
                applyZoom(message.zoom);
            } else if (message.type === 'zoomIn') {
                stepZoom(1);
            } else if (message.type === 'zoomOut') {
                stepZoom(-1);
            } else if (message.type === 'reload') {
                hideContextMenu();
                image.src = message.src;
            }
        });
    </script>
</body>
</html>`;
    }
}

/**
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {number} renderedWidth
 * @param {number} renderedHeight
 * @param {number} pixelRatio
 */
function rasterLayout(naturalWidth, naturalHeight, renderedWidth, renderedHeight, pixelRatio) {
    const requestedWidth = Math.max(naturalWidth, Math.round(renderedWidth * pixelRatio));
    const requestedHeight = Math.max(naturalHeight, Math.round(renderedHeight * pixelRatio));
    const scale = Math.min(
        1,
        8192 / requestedWidth,
        8192 / requestedHeight,
        Math.sqrt((16 * 1024 * 1024) / (requestedWidth * requestedHeight))
    );
    return {
        width: Math.max(1, Math.floor(requestedWidth * scale)),
        height: Math.max(1, Math.floor(requestedHeight * scale)),
        downscaled: scale < 1
    };
}

/** @param {number} width @param {number} height @param {number} zoom */
function numericZoomLayout(width, height, zoom) {
    const scaledWidth = Math.round(width * zoom);
    const scaledHeight = Math.round(height * zoom);
    return {
        imageWidth: `${scaledWidth}px`,
        imageHeight: `${scaledHeight}px`,
        canvasWidth: `max(100%, ${scaledWidth}px)`,
        canvasHeight: `max(100%, ${scaledHeight}px)`
    };
}

/** @param {number} bytes */
function formatFileSize(bytes) {
    if (bytes < 1024) {
        return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/** @param {string | number} zoom */
function zoomLabel(zoom) {
    if (typeof zoom === 'string' && ZOOM_MODE_LABELS[zoom]) {
        return ZOOM_MODE_LABELS[zoom];
    }
    return `${Math.round(Number(zoom) * 100)}%`;
}

/** @param {vscode.Uri | { path: string }} uri @returns {ImageFormat} */
function getSupportedFormat(uri) {
    const extension = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
    const format = SUPPORTED_FORMATS.find(candidate => candidate.extension === extension);
    if (!format) {
        throw new Error(`Unsupported image format: ${uri.path}`);
    }
    return format;
}

function createNonce() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
        value += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return value;
}

/** @param {string} value */
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const provider = new ImagePreviewProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: true
        }),
        vscode.commands.registerCommand('imagePreview.selectZoom', () => provider.selectZoom()),
        vscode.commands.registerCommand('imagePreview.zoomIn', () => provider.zoomIn()),
        vscode.commands.registerCommand('imagePreview.zoomOut', () => provider.zoomOut())
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    ImagePreviewProvider,
    SUPPORTED_FORMATS,
    formatFileSize,
    getSupportedFormat,
    numericZoomLayout,
    rasterLayout,
    zoomLabel
};
