#!/bin/env bash

echo "Installing VSCode Workspace Indicator..."

if type "pacman" > /dev/null 2>&1
then
    # check if already install, else install
    pacman -Qi python-nautilus &> /dev/null
    if [ `echo $?` -eq 1 ]
    then
        sudo pacman -S --noconfirm python-nautilus
    else
        echo "python-nautilus is already installed"
    fi
elif type "apt-get" > /dev/null 2>&1
then
    # Find Ubuntu python-nautilus package
    package_name="python-nautilus"
    found_package=$(apt-cache search --names-only $package_name)
    if [ -z "$found_package" ]
    then
        package_name="python3-nautilus"
    fi

    # Check if the package needs to be installed and install it
    installed=$(apt list --installed $package_name -qq 2> /dev/null)
    if [ -z "$installed" ]
    then
        sudo apt-get install -y $package_name
    else
        echo "$package_name is already installed."
    fi
elif type "dnf" > /dev/null 2>&1
then
    installed=`dnf list --installed nautilus-python 2> /dev/null`
    if [ -z "$installed" ]
    then
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
NAUTILUS_EXTENSION_PATH="$HOME/.local/share/nautilus-python/extensions/vscode_nautilus_workspaces.py"
GTK_EXTENSION_PATH="$HOME/.local/share/bin/vscode-indicator/vscode_workspaces_indicator.py"

# Remove previous version and setup folder
echo "Removing previous version (if found)..."
mkdir -p ~/.local/share/nautilus-python/extensions
mkdir -p ~/.local/share/bin/vscode-indicator
rm -f $GTK_EXTENSION_PATH
rm -f $NAUTILUS_EXTENSION_PATH

# Function to create the .desktop file
create_desktop_file() {
    cat > "$DESKTOP_FILE_PATH" << EOL
[Desktop Entry]
Version=1.0
Name=VSCode Indicator
Exec=/usr/bin/env python3 $GTK_EXTENSION_PATH
Icon=vscode
Type=Application
StartupNotify=false
StartupWMClass=Code
Categories=Utility;
EOL
    # Copy the .desktop file to autostart directory
    mkdir -p "$HOME/.config/autostart"
    cp "$DESKTOP_FILE_PATH" "$AUTOSTART_FILE_PATH"
}

# Function to download and install the Nautilus extension
install_nautilus_extension() {
    mkdir -p ~/.local/share/nautilus-python/extensions
    wget --show-progress -q -O $NAUTILUS_EXTENSION_PATH https://raw.githubusercontent.com/ZanzyTHEbar/vscode-nautilus/main/vscode_nautilus_workspaces.py

    # Ensure the Python script is executable
    if [ -f $NAUTILUS_EXTENSION_PATH ]; then
        chmod +x $NAUTILUS_EXTENSION_PATH
        echo "Nautilus extension installed successfully."
    else
        echo "Error: Nautilus extension script not found."
        exit 1
    fi

    # Restart nautilus
    echo "Restarting nautilus..."
    nautilus -q
}

# Function to download and install the GTK extension
install_gtk_extension() {
    mkdir -p ~/.local/share/bin/vscode-indicator
    wget --show-progress -q -O $GTK_EXTENSION_PATH https://raw.githubusercontent.com/ZanzyTHEbar/vscode-nautilus/main/vscode_workspaces_indicator.py

    # Ensure the Python script is executable
    if [ -f $GTK_EXTENSION_PATH ]; then
        chmod +x $GTK_EXTENSION_PATH
        echo "GTK extension installed successfully."
    else
        echo "Error: GTK extension script not found."
        exit 1
    fi

    # Create the .desktop file for autostart
    create_desktop_file
}

# Prompt the user for installation options
echo "Which components would you like to install?"
echo "1) Nautilus extension"
echo "2) GTK extension"
echo "3) Both"
echo "4) None (exit)"

exec < /dev/tty
read -p "Enter your choice [1-4]: " choice

# If no choice is made, default to exiting
if [ -z "$choice" ]; then
    echo "No choice made. Exiting."
    exit 0
fi

case $choice in
    1)
        install_nautilus_extension
        ;;
    2)
        install_gtk_extension
        ;;
    3)
        install_nautilus_extension
        install_gtk_extension
        ;;
    4)
        echo "Exiting without installing any components."
        exit 0
        ;;
    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac

echo "Setup complete. The selected components have been installed and will take effect on the next login."