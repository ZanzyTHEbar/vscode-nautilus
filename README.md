# VSCode Nautilus Extension

This repo provides a GNOME Shell extension for accessing visual studio code/codium recently opened workspaces/directories.

Provided are two other extension, for Nautilus.

The first, `vscode_nautilus_workspaces.py`, adds a right-click context menu to select from a list of recently accessed workspaces or directories and open in Visual Studio Code.

The second, `vscode_nautilus_open.py`, adds a right-click context menu to open a folder or file in Visual Studio Code.

## Install Extension

```bash
bash <(wget -qO- https://raw.githubusercontent.com/ZanzyTHEbar/vscode-nautilus/main/install.sh)
```

## Uninstall GNOME Shell Extension

To uninstall a GNOME Shell extension, you can use the GNOME Tweaks application or the `gnome-extensions` command.

```bash
gnome-extensions disable vscode-workspaces-gnome@prometheontechnologies.com
gnome-extensions uninstall vscode-workspaces-gnome@prometheontechnologies.com
```

You can also remove the directory manually.

```bash
rm -rf ~/.local/share/gnome-shell/extensions/vscode-workspaces-gnome@prometheontechnologies.com
```

## Uninstall Nautilus Extensions

```bash
rm -f ~/.local/share/nautilus-python/extensions/vscode_nautilus_workspaces.py
rm -f ~/.local/share/nautilus-python/extensions/vscode_nautilus_open.py
```

## Usage

### Nautilus Extensions

To open a folder or file in Visual Studio Code, right-click on an item in Nautilus and select the "Open in Code" option.

To open a recent folder or workspace, right-click on an empty space in Nautilus and select the "Open Recent Workspaces" option.

### GNOME Shell Extension

To open a recent folder or workspace, click on the Visual Studio Code icon in the top bar and select a recent folder or workspace.

You also have various options to configure the extension in the GNOME Tweaks application.
