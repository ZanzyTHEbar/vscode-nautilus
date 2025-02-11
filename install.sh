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
    wget --show-progress -q -O $NAUTILUS_EXTENSION_WORKSPACE_PATH https://raw.githubusercontent.com/ZanzyTHEbar/vscode-workspaces/main/vscode_nautilus_workspaces.py
    wget --show-progress -q -O $NAUTILUS_EXTENSION_OPEN_PATH https://raw.githubusercontent.com/ZanzyTHEbar/vscode-workspaces/main/vscode-nautilus-open.py

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

# URL to check
URL_TO_CHECK=""
# GitHub repository and file to download
GITHUB_REPO="ZanzyTHEbar/vscode-workspaces"
RELEASE_FILE="vscode-workspaces.zip"

# Function to check if URL exists
check_url() {
    HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" "$1")
    if [ "$HTTP_STATUS" -eq 200 ]; then
        return 0
    else
        return 1
    fi
}

# Function to download file from GitHub releases
download_from_github() {
    LATEST_RELEASE=$(curl -s https://api.github.com/repos/$1/releases/latest | grep "tag_name" | awk '{print substr($2, 2, length($2)-3)}')
    DOWNLOAD_URL="https://github.com/$1/releases/download/$LATEST_RELEASE/$2"
    curl -L -o "/tmp/$2" "$DOWNLOAD_URL"
}

install_gnome_shell_extension() {
    # Check if the GNOME Shell extension is installed
    gnome_shell_extension_id="vscode-workspaces@prometheontechnologies.com"
    gnome_shell_extension_installed=$(gnome-extensions list | grep $gnome_shell_extension_id)

    if [ -z "$gnome_shell_extension_installed" ]; then
        if check_url "$URL_TO_CHECK"; then
            # open the URL in the default browser
            xdg-open "$URL_TO_CHECK"

            echo "Please download the GNOME Shell extension from the URL above and install it manually."

        else
            echo "GNOME Shell extensions website is not responding: $URL_TO_CHECK"
            echo "Downloading $RELEASE_FILE from GitHub repo $GITHUB_REPO..."
            download_from_github "$GITHUB_REPO" "$RELEASE_FILE"
            if [ $? -eq 0 ]; then
                echo "Downloaded $RELEASE_FILE successfully."
            else
                echo "Failed to download $RELEASE_FILE."
            fi
        fi

        # Install the GNOME Shell extension
        gnome-extensions install /tmp/vscode-workspaces.zip
        gnome-extensions enable $gnome_shell_extension_id
        echo "GNOME Shell extension installed successfully."
    else
        echo "GNOME Shell extension already installed."
    fi
}

# Prompt the user for installation options
echo "Which components would you like to install?"
echo "1) Nautilus extensions"
echo "2) GNOME Shell extension"
echo "3) Both"
echo "4) None (exit)"

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
    install_gnome_shell_extension
    ;;
3)
    install_nautilus_extensions
    install_gnome_shell_extension
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

echo "Setup complete. The selected components have been installed and might need a re-login to take effect."
