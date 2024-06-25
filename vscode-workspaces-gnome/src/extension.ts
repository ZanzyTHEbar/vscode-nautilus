import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
// https://gjs.guide/extensions/topics/notifications.html
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { FileChooserDialog } from './fileChooser.js';


export default class VSCodeWorkspacesExtension extends Extension {
    gsettings?: Gio.Settings;
    _indicator?: PanelMenu.Button;
    _refreshInterval: number = 300;
    _refreshTimeout: any = null;
    _newWindow: boolean = false;
    _vscodeLocation: string = "";
    _recentWorkspacesPath: string = GLib.build_filenamev([GLib.get_home_dir(), '.config/Code/User/workspaceStorage']);
    _workspaceFiles: string[] = [];

    enable() {

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const icon = new St.Icon({
            icon_name: 'code',
            style_class: 'system-status-icon'
        });

        this._indicator.add_child(icon);

        this._createMenu();

        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator);

        this._startRefresh();

        this.gsettings = this.getSettings();

        this._newWindow = this.gsettings!.get_value('new-window').deepUnpack() ?? false
        this._vscodeLocation = this.gsettings!.get_value('vscode-location').deepUnpack() ?? "code"
        this._refreshInterval = this.gsettings!.get_value('refresh-interval').deepUnpack() ?? 300
    }

    disable() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }
        this.gsettings = undefined;

        log(`VSCode Workspaces Extension disabled`);
    }

    _createMenu() {

        if (!this._indicator) return;

        (this._indicator.menu as PopupMenu.PopupMenu).removeAll();

        log(`VSCode Workspaces Extension enabled`);
        log(`New Window: ${this._newWindow}`);
        log(`VSCode Location: ${this._vscodeLocation}`);
        log(`Refresh Interval: ${this._refreshInterval}`);

        this._loadRecentWorkspaces();

        const itemAddWorkspace = new PopupMenu.PopupMenuItem('Add Workspace');
        itemAddWorkspace.connect('activate', () => {
            this._addWorkspaceItem();
        });
        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemAddWorkspace);

        const itemSettings = new PopupMenu.PopupSubMenuMenuItem('Settings');
        const itemClearWorkspaces = new PopupMenu.PopupMenuItem('Clear Workspaces');
        itemClearWorkspaces.connect('activate', () => {
            this._clearRecentWorkspaces();
        });

        const itemRefresh = new PopupMenu.PopupMenuItem('Refresh');
        itemRefresh.connect('activate', () => {
            this._createMenu();
        });

        itemSettings.menu.addMenuItem(itemClearWorkspaces);
        itemSettings.menu.addMenuItem(itemRefresh);

        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemSettings);

        const itemQuit = new PopupMenu.PopupMenuItem('Quit');
        itemQuit.connect('activate', () => {
            this._quit();
        });
        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemQuit);
    }

    _loadRecentWorkspaces() {
        const recentWorkspaces = this._getRecentWorkspaces();

        if (recentWorkspaces.length === 0) {
            log('No recent workspaces found');
            return;
        }

        // Create a combo_box-like button for the recent workspaces
        const comboBoxButton: St.Button = new St.Button({
            label: recentWorkspaces[0].name,
            style_class: 'workspace-combo-button',
            reactive: true,
            can_focus: true,
            track_hover: true
        });

        comboBoxButton.connect('clicked', (button: St.Button) => {
            comboBoxMenu.toggle();
        });

        // Create the PopupMenu for the ComboBox items

        const comboBoxSubMenu = new PopupMenu.PopupSubMenuMenuItem('Recent Workspaces');

        const comboBoxMenu = comboBoxSubMenu.menu;
        recentWorkspaces.forEach(workspace => {
            const item = new PopupMenu.PopupMenuItem(workspace.name);

            const trashIcon = new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'trash-icon'
            });

            const trashButton = new St.Button({
                child: trashIcon,
                style_class: 'trash-button',
                reactive: true,
                can_focus: true,
                track_hover: true
            });

            trashButton.connect('enter-event', () => {
                trashIcon.add_style_class_name('trash-icon-hover');
            });

            trashButton.connect('leave-event', () => {
                trashIcon.remove_style_class_name('trash-icon-hover');
            });

            trashButton.connect('clicked', () => {
                workspace.softRemove();
            });

            item.add_child(trashButton);

            item.connect('activate', () => {
                comboBoxButton.label = workspace.name;
                this._openWorkspace(workspace.path);
            });
            comboBoxMenu.addMenuItem(item);
        });

        // Add the ComboBox button to the menu
        const comboBoxMenuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        comboBoxMenuItem.actor.add_child(comboBoxButton);
        (this._indicator?.menu as PopupMenu.PopupMenu).addMenuItem(comboBoxMenuItem);

        // Add the ComboBox submenu to the menu
        (this._indicator?.menu as PopupMenu.PopupMenu).addMenuItem(comboBoxSubMenu);
    }

    _iterateWorkspaceDir(dir: Gio.File, callback: (path: {
        workspace: boolean,
        dir: string,
        file: string | null
    }, file: Gio.File | null) => void) {

        try {
            // compare the file path with the child paths in the recent workspaces directory
            const enumerator = dir.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);

            let info: Gio.FileInfo | null;

            while ((info = enumerator.next_file(null)) !== null) {
                const _file = enumerator.get_child(info);
                if (_file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
                    continue;
                }

                const workspaceFile = _file.get_child('workspace.json');
                if (!workspaceFile.query_exists(null)) {
                    log(`No workspace.json found in ${_file.get_path()}`);
                    continue;
                }

                // parse the json file
                const [ok, content] = workspaceFile.load_contents(null);
                if (!ok) {
                    log('Failed to load workspace.json');
                    continue;
                }

                const json = JSON.parse(content.toString());

                // Check if the json file has a `folder` property or a `workspace` property - check if the previous item in `workspaceFiles` is the same as the current item
                // we want to grab the contents either folder or workspace property and check if it's the same as the previous item in `workspaceFiles`
                // if it is, we want to skip this item
                // if it isn't, we want to add it to `workspaceFiles`

                const item = (json.folder || json.workspace) as string | undefined;
                if (!item) {
                    log('No folder or workspace property found in workspace.json');
                    continue;
                }

                log(`Found workspace.json in ${_file.get_path()}: ${item}`);

                // Check if the item is a file or a directory
                const parsedPath = item.replace('file://', '');
                const path: {
                    workspace: boolean,
                    dir: string,
                    file: string | null
                } = GLib.file_test(parsedPath, GLib.FileTest.IS_DIR) ? {
                    dir: parsedPath,
                    workspace: false,
                    file: null
                } : {
                        dir: GLib.path_get_dirname(parsedPath),
                        workspace: true,
                        // get the file at the end of the uri path
                        file: GLib.path_get_basename(parsedPath)
                    };
                callback(path, _file);
            }

            const enumCloseRes = enumerator.close(null);

            if (!enumCloseRes) {
                throw new Error('Failed to close enumerator');
            }
        } catch (error) {
            logError((error as object), 'Failed to iterate workspace directory');
        }
    }

    _getRecentWorkspaces() {
        try {
            // walk the directory and get the most recent workspaces but creating a map of the workspace.json files within the subdirectories
            const dir = Gio.File.new_for_path(this._recentWorkspacesPath);

            this._iterateWorkspaceDir(dir, (path, file) => {

                if (!file) {
                    throw new Error('No file found');
                }

                const { workspace, dir: _dir, file: _fileName } = path;
                const _path = workspace ? GLib.build_filenamev([_dir, _fileName!]) : _dir;

                // check for duplicates
                if (this._workspaceFiles.includes(_path)) {
                    log(`Duplicate workspace found: ${_path}`);
                    return;
                }

                // If the _path is a file, check if the parent directory is already in the list
                if (workspace && this._workspaceFiles.includes(_dir)) {
                    log(`Parent directory already in workspace files: ${_dir}`);
                    // Remove the parent directory from the list
                    this._workspaceFiles = this._workspaceFiles.filter(path => path !== _dir);
                }

                log(`Adding workspace: ${_path}`);
                this._workspaceFiles.push(_path);
            });

            // sort the workspace files by modification time
            this._workspaceFiles.sort((a, b) => {
                const aInfo = Gio.File.new_for_path(a).query_info('standard::time', Gio.FileQueryInfoFlags.NONE, null);
                const bInfo = Gio.File.new_for_path(b).query_info('standard::time', Gio.FileQueryInfoFlags.NONE, null);

                if (!aInfo || !bInfo) {
                    return 0;
                }

                const aTime = aInfo.get_modification_time().tv_sec;
                const bTime = bInfo.get_modification_time().tv_sec;

                return aTime - bTime;
            });

            // get the most recent workspaces
            //const recentWorkspaces = workspaceFiles.slice(-5).map(file => {
            //    return { name: GLib.path_get_basename(file), path: file };
            //});

            // check if the file exists and remove it from the list if it doesn't
            this._workspaceFiles = this._workspaceFiles.filter(file => {
                const exists = GLib.file_test(file, GLib.FileTest.EXISTS);
                if (!exists) {
                    log(`File does not exist: ${file}`);
                }
                return exists;
            });

            const recentWorkspaces = this._workspaceFiles.map(file => {
                return {
                    name: GLib.path_get_basename(file),
                    path: file,
                    softRemove: () => {
                        // remove from the list of recent workspaces, but not the recent workspace directory
                        log(`Removing workspace: ${file}`);
                        this._workspaceFiles = this._workspaceFiles.filter(path => path !== file);

                        // now remove the workspace directory
                        const dir = Gio.File.new_for_path(this._recentWorkspacesPath);
                        this._iterateWorkspaceDir(dir, (path, _file) => {
                            const { workspace, dir: _dir, file: _fileName } = path;
                            const _path = workspace ? GLib.build_filenamev([_dir, _fileName!]) : _dir;

                            // ensure that the path is the same as the file path
                            if (file !== _path) {
                                return;
                            }

                            if (!_file) {
                                log(`No file found for ${file}`);
                                return;
                            }

                            const _filePath = _file.get_path()!;

                            log(`Moving Workspace to Trash: ${_filePath}`);
                            const workspaceDir = Gio.File.new_for_path(_filePath);
                            const trashRes = workspaceDir.trash(null);

                            if (!trashRes) {
                                log(`Failed to move ${_filePath} to trash`);
                                return;
                            }

                            log(`Workspace Trashed: ${_filePath}`);
                            // Refresh the menu to reflect the changes
                            this._createMenu();
                        });
                    },
                    removeWorkspaceItem: () => {
                        // remove from the list of recent workspaces, and remove the recent workspace directory, but not the file location of the workspace    

                        // compare the file path with the child paths in the recent workspaces directory
                        const dir = Gio.File.new_for_path(this._recentWorkspacesPath);

                        this._iterateWorkspaceDir(dir, (path, _file) => {

                            const { workspace, dir: _dir, file: _fileName } = path;
                            const _path = workspace ? GLib.build_filenamev([_dir, _fileName!]) : _dir;

                            // ensure that the path is the same as the file path
                            if (file !== _path) {
                                return;
                            }

                            if (!_file) {
                                log(`No file found for ${file}`);
                                return;
                            }

                            // Delete the containing directory for the workspace.json file
                            log(`Removing workspace: ${_file.get_path()}`);
                            _file.delete(null);
                        });

                        this._createMenu();
                    }
                };
            });

            log(`Recent Workspaces: ${JSON.stringify(recentWorkspaces)}`);

            return recentWorkspaces;

        } catch (e) {
            logError((e as object), 'Failed to load recent workspaces');
            return [];
        }
    }

    _launchVSCode(files: string[]): void {
        log(`Launching VSCode with files: ${files.join(', ')}`);

        try {
            let safePaths = '';
            let args = '';

            files.forEach(file => {
                safePaths += `"${file}" `;
                log(`File Path: ${file}`);

                if (GLib.file_test(file, GLib.FileTest.IS_DIR) && GLib.file_test(file, GLib.FileTest.EXISTS)) {
                    log(`Found a directory: ${file}`);
                    args = '--new-window';
                }
            });

            const newWindow = this._newWindow ? '--new-window' : '';

            if (args === '') {
                args = newWindow ? '--new-window' : '';
            }
            const command = `${this._vscodeLocation} ${args} ${safePaths}`;
            log(`Command to execute: ${command}`);
            GLib.spawn_command_line_async(command);
        } catch (error) {
            logError((error as object), 'Failed to launch VSCode');
        }
    }

    _openWorkspace(workspacePath: string) {
        log(`Opening workspace: ${workspacePath}`);
        this._launchVSCode([workspacePath]);
    }

    _addWorkspaceItem() {
        try {

            const fileChooserDialog = FileChooserDialog((filePath: string) => {

                log(`Selected file: ${filePath}`);

                // Check if the workspace is already in the list
                const recentWorkspaces = this._getRecentWorkspaces();
                const workspaceExists = recentWorkspaces.some(workspace => workspace.path === filePath);

                if (workspaceExists) {
                    log('Workspace already exists in recent workspaces');
                    return;
                }

                // Impl handle ~/ and environment variables in the path
                const file = Gio.File.new_for_path(filePath);
                filePath = file.get_path()!;
                log(`Adding workspace: ${filePath}`);

                // launch vscode with the workspace
                this._launchVSCode([filePath]);
                // Refresh the menu to reflect the changes
                this._createMenu();
            });

            fileChooserDialog.open();
        } catch (e) {
            logError((e as object), 'Failed to load recent workspaces');
            return [];
        }
    }

    _clearRecentWorkspaces() {
        log('Clearing recent workspaces');

        if (!GLib.file_test(this._recentWorkspacesPath, GLib.FileTest.EXISTS | GLib.FileTest.IS_DIR)) {
            throw new Error('Recent workspaces directory does not exist');
        }

        try {
            // Create a backup of the directory before deleting it
            const backupPath = `${this._recentWorkspacesPath}.bak`;
            const backupDir = Gio.File.new_for_path(backupPath);
            const recentWorkspacesDir = Gio.File.new_for_path(this._recentWorkspacesPath);

            if (backupDir.query_exists(null)) {
                throw new Error('Backup directory already exists');
            }

            log(`Creating backup of ${this._recentWorkspacesPath} to ${backupPath}`);

            const res = recentWorkspacesDir.copy(backupDir, Gio.FileCopyFlags.OVERWRITE, null, null);

            if (res === null) {
                throw new Error('Failed to create backup');
            }

            log('Backup created successfully');


            // Delete the children of the directory
            const enumerator = recentWorkspacesDir.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);

            let info: Gio.FileInfo | null;

            while ((info = enumerator.next_file(null)) !== null) {
                const file = enumerator.get_child(info);
                if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
                    continue;
                }

                log(`Deleting ${file.get_path()}`);
                file.delete(null);
            }

            // Refresh the menu to reflect the changes

            this._createMenu();
        } catch (e) {
            logError(`Failed to clear recent workspaces: ${e}`);
        }
    }

    _quit() {
        if (this._indicator) {
            this._indicator.destroy();
        }
    }

    _startRefresh() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        this._refreshTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._refreshInterval, () => {
            this._createMenu();
            return GLib.SOURCE_CONTINUE;
        });
    }
}