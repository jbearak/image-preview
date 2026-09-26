# SVG & PNG Preview

A deliberately small alternative to VS Code's built-in image viewer. It renders
transparency without a checkerboard, adds a **Fit Width** zoom mode, and lets you
copy the preview.

## Features

- Renders transparent SVG and PNG images against the current editor background.
- Provides **Fit Width**, which fills the available width while allowing vertical scrolling.
- Copies a rendered SVG as a transparent PNG.
- Copies a PNG using its original encoded payload without re-rasterizing it.
- Opens at **Fit** by default and also offers Actual Size and percentage zoom levels.
- Matches VS Code's built-in image viewer by showing zoom, intrinsic dimensions, and file size in the status bar.
- Refreshes when an SVG or PNG changes on disk.

## Use

Open an SVG or PNG. To make this extension the persistent choice, run
**View: Reopen Editor With...**, choose **Configure default editor for `*.svg`**
or **Configure default editor for `*.png`**, and select **SVG & PNG Preview**.

Click **Fit** in the status bar or right-click the preview to choose another zoom
level. **Fit** scales the image up or down to fill the available space while
keeping the whole image visible. **Fit Width** fills the available width and
allows vertical scrolling for tall images. The command
palette also provides **SVG & PNG Preview: Zoom In** and
**SVG & PNG Preview: Zoom Out**.

## License

Copyright 2026 Jonathan Marc Bearak. Licensed under the [GNU GPL v3](LICENSE).
