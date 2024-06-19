#!/usr/bin/env python3

import gi
import logging
from subprocess import call
import json

import os
import sys

gi.require_version("Gtk", "3.0")
gi.require_version("AppIndicator3", "0.1")
from gi.repository import Gtk, AppIndicator3, GLib


# Path to the recent workspaces JSON file
RECENT_WORKSPACES_PATH = os.path.expanduser(
    "~/.config/Code/User/globalStorage/storage.json"
)

# path to vscode
VSCODE = "code"

# what name do you want to see in the context menu?
VSCODENAME = "Code"

# always create new window?
NEWWINDOW = False

LOGGING_PATH = "/tmp/vscode_workspaces_extension.log"

# Configure logging
logging.basicConfig(filename=LOGGING_PATH, level=logging.DEBUG)


class VSCodeIndicator:
    def __init__(self):
        self.indicator = AppIndicator3.Indicator.new(
            "vscode-indicator",
            "code",  # Use the VS Code icon name or path to the icon
            AppIndicator3.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
        self.indicator.set_menu(self.create_menu())
        GLib.timeout_add_seconds(10, self.on_refresh)  # Refresh every 10 seconds

    def create_menu(self):
        menu = Gtk.Menu()

        # Add dynamic menu items
        self.add_dynamic_items(menu)

        item_clear_history = Gtk.MenuItem(label="Clear Recent Workspaces")
        item_clear_history.connect("activate", self._clear_recent_workspaces)
        menu.append(item_clear_history)

        open_logs = Gtk.MenuItem(label="Open Logs")
        open_logs.connect("activate", self._open_logs)
        menu.append(open_logs)

        item_refresh = Gtk.MenuItem(label="Refresh")
        item_refresh.connect("activate", self.on_refresh)
        menu.append(item_refresh)

        item_quit = Gtk.MenuItem(label="Quit")
        item_quit.connect("activate", self.on_quit)
        menu.append(item_quit)

        menu.show_all()
        return menu

    def add_dynamic_items(self, menu):
        recent_workspaces = self._get_recent_workspaces()
        if recent_workspaces:
            for workspace in recent_workspaces:
                # Create a menu item for each workspace that takes only the last part of the path as the label
                workspace_name = os.path.basename(workspace)

                item = Gtk.MenuItem(label=workspace_name)
                item.connect("activate", self._open_workspace, workspace)
                menu.append(item)
        else:
            item_no_workspace = Gtk.MenuItem(label="No recent workspaces")
            menu.append(item_no_workspace)

    def launch_vscode(self, files):
        logging.info(f"Launching {VSCODENAME} with {files}")

        safepaths = ""
        args = ""

        for file in files:
            safepaths += '"' + file + '" '

            logging.info(f"File path: {safepaths}")

            # If one of the files we are trying to open is a folder
            # create a new instance of vscode
            if os.path.isdir(file) and os.path.exists(file):
                logging.info(f"Found a directory: {file}")
                args = "--new-window "

        args = "--new-window " if NEWWINDOW else ""
        command = f"{VSCODE} {args} {safepaths} &"
        logging.info(f"Command to execute: {command}")

        try:
            call(command, shell=True)
            logging.info(f"Successfully launched {VSCODENAME} with {safepaths}")
        except Exception as e:
            logging.error(f"Failed to launch {VSCODENAME} with {safepaths}: {e}")

    def _get_recent_workspaces(self):
        if not os.path.exists(RECENT_WORKSPACES_PATH):
            logging.debug("Recent workspaces file not found")
            return []

        with open(RECENT_WORKSPACES_PATH, "r") as f:
            storage_data = json.load(f)

        # logging.debug(f"Read storage data: {storage_data}")

        # Extract workspaces from profileAssociations
        workspaces = storage_data.get("profileAssociations", {}).get("workspaces", {})
        workspace_paths = [ws.replace("file://", "") for ws in workspaces.keys()]
        logging.info(f"Workspace paths: {workspace_paths}")
        return workspace_paths

    def _clear_recent_workspaces(self, widget):
        logging.info("Clearing recent workspaces")
        if not os.path.exists(RECENT_WORKSPACES_PATH):
            logging.debug("Recent workspaces file not found")
            return

        try:
            with open(RECENT_WORKSPACES_PATH, "r+") as f:
                storage_data = json.load(f)
                if "profileAssociations" in storage_data:
                    storage_data["profileAssociations"]["workspaces"] = {}
                f.seek(0)
                f.truncate()
                json.dump(storage_data, f)
            logging.info("Successfully cleared recent workspaces")
        except Exception as e:
            logging.error(f"Failed to clear recent workspaces: {e}")

        # Refresh the menu to reflect the changes
        self.on_refresh(widget)

    def _open_workspace(self, widget, workspace_path):
        logging.debug(f"Opening workspace: {workspace_path}")
        self.launch_vscode([workspace_path])

    def _open_logs(self, widget):
        logging.debug(f"Opening Logs: {LOGGING_PATH}")
        self.launch_vscode([LOGGING_PATH])

    def on_refresh(self, widget):
        # Refresh the menu
        self.indicator.set_menu(self.create_menu())

    def on_quit(self, widget):
        Gtk.main_quit()


if __name__ == "__main__":
    try:
        indicator = VSCodeIndicator()
        Gtk.main()
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
