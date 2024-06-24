#!/bin/env bash

echo "Installing VSCode Workspace Indicator..."

if type "pacman" >/dev/null 2>&1; then
    # check if already install, else install
    pacman -Qi python-nautilus &>/dev/null
    if [ $(echo $?) -eq 1 ]; then
        sudo pacman -S --noconfirm python-nautilus
    else
        echo "python-nautilus is already installed"
    fi
elif type "apt-get" >/dev/null 2>&1; then
    # Find Ubuntu python-nautilus package
    package_name="python-nautilus"
    found_package=$(apt-cache search --names-only $package_name)
    if [ -z "$found_package" ]; then
        package_name="python3-nautilus"
    fi

    # Check if the package needs to be installed and install it
    installed=$(apt list --installed $package_name -qq 2>/dev/null)
    if [ -z "$installed" ]; then
        sudo apt-get install -y $package_name
    else
        echo "$package_name is already installed."
    fi
elif type "dnf" >/dev/null 2>&1; then
    installed=$(dnf list --installed nautilus-python 2>/dev/null)
    if [ -z "$installed" ]; then
        sudo dnf install -y nautilus-python
    else
        echo "nautilus-python is already installed."
    fi
else
    echo "Failed to find python-nautilus, please install it manually."
fi

# Variables
DESKTOP_FILE_PATH="$HOME/.local/share/applications/vscode_indicator.desktop"
AUTOSTART_FILE_PATH="$HOME/.config/autostart/vscode_indicator.desktop"
NAUTILUS_EXTENSION_WORKSPACE_PATH="$HOME/.local/share/nautilus-python/extensions/vscode_nautilus_workspaces.py"
NAUTILUS_EXTENSION_OPEN_PATH="$HOME/.local/share/nautilus-python/extensions/vscode-nautilus-open.py"

# Remove previous version and setup folder
echo "Removing previous version (if found)..."
mkdir -p ~/.local/share/nautilus-python/extensions
rm -f $NAUTILUS_EXTENSION_WORKSPACE_PATH
rm -f $NAUTILUS_EXTENSION_OPEN_PATH

# Function to download and install the Nautilus extension
install_nautilus_extensions() {
    mkdir -p ~/.local/share/nautilus-python/extensions
    wget --show-progress -q -O $NAUTILUS_EXTENSION_WORKSPACE_PATH https://raw.githubusercontent.com/ZanzyTHEbar/vscode-nautilus/main/vscode_nautilus_workspaces.py
    wget --show-progress -q -O $NAUTILUS_EXTENSION_OPEN_PATH https://raw.githubusercontent.com/ZanzyTHEbar/vscode-nautilus/main/vscode-nautilus-open.py

    # Ensure the Python scripts are executable
    if [ -f $NAUTILUS_EXTENSION_WORKSPACE_PATH ] && [ -f $NAUTILUS_EXTENSION_OPEN_PATH ]; then
        chmod +x $NAUTILUS_EXTENSION_WORKSPACE_PATH
        chmod +x $NAUTILUS_EXTENSION_OPEN_PATH
        echo "Nautilus extensions installed successfully."
    else
        echo "Error: Nautilus extension scripts not found."
        exit 1
    fi

    # Restart nautilus
    echo "Restarting nautilus..."
    nautilus -q
}

# Prompt the user for installation options
echo "Which components would you like to install?"
echo "1) Nautilus extensions"
echo "2) None (exit)"

read -p "Enter your choice [1-4]: " choice

# If no choice is made, default to exiting
if [ -z "$choice" ]; then
    echo "No choice made. Exiting."
    exit 0
fi

case $choice in
1)
    install_nautilus_extensions
    ;;
2)
    echo "Exiting without installing any components."
    exit 0
    ;;
*)
    echo "Invalid choice. Exiting."
    exit 1
    ;;
esac

echo "Setup complete. The selected components have been installed and will take effect on the next login."
