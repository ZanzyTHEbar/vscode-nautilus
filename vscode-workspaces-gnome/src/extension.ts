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

interface Workspace {
    uri: string,
    storeDir: Gio.File | null,
}

interface RecentWorkspace {
    name: string;
    path: string;
    softRemove: () => void;
    removeWorkspaceItem: () => void;
}


export default class VSCodeWorkspacesExtension extends Extension {
    gsettings?: Gio.Settings;
    _indicator?: PanelMenu.Button;

    _refreshInterval: number = 300;
    _refreshTimeout: any = null;
    _newWindow: boolean = false;
    _vscodeLocation: string = "";

    _recentWorkspacesPath: string = GLib.build_filenamev([GLib.get_home_dir(), '.config/Code/User/workspaceStorage']);
    _workspaces: Set<Workspace> = new Set();
    _recentWorkspaces: Set<RecentWorkspace> = new Set();

    // TODO: Implement notifications
    //_messageTray: MessageTray.MessageTray | null = null;
    //_notificationSource: MessageTray.Source | null = null;
    //_notification: MessageTray.Notification | null = null;

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
        this._getRecentWorkspaces();

        if (this._recentWorkspaces.size === 0) {
            log('No recent workspaces found');
            return;
        }

        // Create a combo_box-like button for the recent workspaces
        const comboBoxButton: St.Button = new St.Button({
            label: 'VSCode Workspaces',
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
        this._recentWorkspaces.forEach(workspace => {
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

    _iterateWorkspaceDir(dir: Gio.File, callback: (workspace: Workspace) => void) {

        try {
            // compare the file path with the child paths in the recent workspaces directory
            const enumerator = dir.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);

            let info: Gio.FileInfo | null;

            while ((info = enumerator.next_file(null)) !== null) {
                try {
                    const workspaceStoreDir = enumerator.get_child(info);

                    log(`Checking ${workspaceStoreDir.get_path()}`);

                    const workspaceFile = Gio.File.new_for_path(GLib.build_filenamev([workspaceStoreDir.get_path()!, 'workspace.json']));

                    if (!workspaceFile.query_exists(null)) {
                        log(`No workspace.json found in ${workspaceStoreDir.get_path()}`);
                        continue;
                    }

                    // load the contents of the workspace.json file and parse it
                    const [, contents] = workspaceFile.load_contents(null);

                    const decoder = new TextDecoder();

                    const json = JSON.parse(decoder.decode(contents));

                    // Check if the json file has a `folder` property or a `workspace` property - check if the previous item in `workspaceFiles` is the same as the current item
                    // we want to grab the contents either folder or workspace property and check if it's the same as the previous item in `workspaceFiles`
                    // if it is, we want to skip this item
                    // if it isn't, we want to add it to `workspaceFiles`

                    const workspaceURI = (json.folder || json.workspace) as string | undefined;
                    if (!workspaceURI) {
                        log('No folder or workspace property found in workspace.json');
                        continue;
                    }

                    log(`Found workspace.json in ${workspaceStoreDir.get_path()} with ${workspaceURI}`);

                    const newWorkspace = {
                        uri: workspaceURI,
                        storeDir: workspaceStoreDir
                    };

                    // Check if a workspace with the same uri exists
                    const workspaceExists = Array.from(this._workspaces).some(workspace => {
                        return workspace.uri === workspaceURI;
                    });

                    if (workspaceExists) {
                        log(`Workspace already exists in recent workspaces: ${workspaceURI}`);
                        continue;
                    }

                    // use a cache to avoid reprocessing the same directory/file
                    if (this._workspaces.has(newWorkspace)) {
                        log(`Workspace already exists: ${newWorkspace}`);
                        continue;
                    }


                    this._workspaces.add(newWorkspace);
                    callback(newWorkspace);
                } catch (error) {
                    logError((error as object), 'Failed to parse workspace.json');
                    continue;
                }
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
            const dir = Gio.File.new_for_path(this._recentWorkspacesPath);

            this._iterateWorkspaceDir(dir, (workspace) => {
                //! This callback checks if the workspace exists and if the parent directory is already in the list

                const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);

                // check if the file exists and remove it from the list if it doesn't
                if (!pathToWorkspace.query_exists(null)) {
                    log(`Workspace does not exist and will be removed from the list: ${pathToWorkspace.get_path()}`);
                    this._workspaces.delete(workspace);
                    return;
                }

                if (pathToWorkspace.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
                    // check if the parent directory is already in the list

                    // get the parent directory
                    const parentDir = pathToWorkspace.get_parent();

                    // construct a uri for the parent directory

                    const parentURI = parentDir?.get_uri();

                    const parentWorkspace = {
                        uri: parentURI!,
                        storeDir: workspace.storeDir
                    };

                    if (!this._workspaces.has(parentWorkspace)) {
                        return;
                    }

                    const parentPath = parentDir?.get_path()!;
                    log(`Parent directory already exists: ${parentPath}`);

                    // remove the parent directory from the list

                    log(`Removing parent directory: ${parentPath}`);

                    this._workspaces.delete(parentWorkspace);

                    return;
                }
            });

            // sort the workspace files by access time
            /* this._workspaces = new Set(Array.from(this._workspaces).sort((a, b) => {

                const aInfo = Gio.File.new_for_uri(a.uri).query_info('standard::*,unix::atime', Gio.FileQueryInfoFlags.NONE, null);
                const bInfo = Gio.File.new_for_uri(b.uri).query_info('standard::*,unix::atime', Gio.FileQueryInfoFlags.NONE, null);

                if (!aInfo || !bInfo) {
                    log(`No file info found for ${a} or ${b}`);
                    return 0;
                }

                const aAccessTime = aInfo.get_attribute_uint64('unix::atime');
                const bAccessTime = bInfo.get_attribute_uint64('unix::atime');

                if (aAccessTime > bAccessTime) {
                    return -1;
                }

                if (aAccessTime < bAccessTime) {
                    return 1;
                }

                return 0;
            })); */
            // log the Set of workspaces, given that .values() returns an iterator
            log(Array.from(this._workspaces).map(workspace => workspace.uri));

            // get the most recent workspaces
            //const recentWorkspaces = workspaceFiles.slice(-5).map(file => {
            //    return { name: GLib.path_get_basename(file), path: file };
            //});

            this._recentWorkspaces = new Set(Array.from(this._workspaces).map(workspace => {
                const workspaceName = GLib.path_get_basename(workspace.uri);

                return {
                    name: workspaceName,
                    path: workspace.uri,
                    softRemove: () => {
                        log(`Moving Workspace to Trash: ${workspaceName}`);
                        // Purge from the recent workspaces
                        this._workspaces.delete(workspace);
                        // Purge from the cache
                        this._recentWorkspaces = new Set(Array.from(this._recentWorkspaces).filter(recentWorkspace => recentWorkspace.path !== workspace.uri));

                        // now remove the workspaceStore directory
                        const trashRes = workspace.storeDir?.trash(null);

                        if (!trashRes) {
                            log(`Failed to move ${workspaceName} to trash`);
                            return;
                        }

                        log(`Workspace Trashed: ${workspaceName}`);

                        // Refresh the menu to reflect the changes
                        this._createMenu();
                    },
                    removeWorkspaceItem: () => {
                        log(`Removing workspace: ${workspaceName}`);
                        // Purge from the recent workspaces
                        this._workspaces.delete(workspace);
                        // Purge from the cache
                        this._recentWorkspaces = new Set(Array.from(this._recentWorkspaces).filter(recentWorkspace => recentWorkspace.path !== workspace.uri));
                        // now remove the workspace directory
                        workspace.storeDir?.delete(null);
                        this._createMenu();
                    }
                };
            }))


            // log the Set of recent workspaces, given that .values() returns an iterator
            log(Array.from(this._recentWorkspaces).map(workspace => workspace.path));

        } catch (e) {
            logError((e as object), 'Failed to load recent workspaces');
        }
    }

    _launchVSCode(files: string[]): void {
        // TODO: Support custom cmd args
        // TODO: Support remote files and folders
        // code --folder-uri vscode-remote://ssh-remote+user@host/path/to/folder


        log(`Launching VSCode with files: ${files.join(', ')}`);

        try {
            let safePaths = '';
            let args = '';
            let isDir = false;

            files.forEach(file => {
                safePaths += `"${file}" `;
                log(`File Path: ${file}`);

                if (GLib.file_test(file, GLib.FileTest.IS_DIR)) {
                    log(`Found a directory: ${file}`);
                    args = '--folder-uri';
                    isDir = true;
                } else {
                    log(`Found a file: ${file}`);
                    args = '--file-uri';
                    isDir = false;
                }
            });

            let newWindow = this._newWindow ? '--new-window' : ''

            if (isDir) {
                newWindow = '--new-window';
            } else {
                newWindow = newWindow;
            }

            const command = `${this._vscodeLocation} ${newWindow} ${args} ${safePaths}`;
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

            const fileChooserDialog = FileChooserDialog(async (filePath: string) => {

                log(`Selected file: ${filePath}`);

                // construct a uri for the filePath
                const uri = Gio.File.new_for_path(filePath).get_uri();

                // Check if the workspace is already in the list
                const workspaceExists = Array.from(this._workspaces).some(workspace => {
                    return workspace.uri === uri;
                });

                if (workspaceExists) {
                    log('Workspace already exists in recent workspaces');
                    return;
                }

                log(`Adding workspace: ${filePath}`);

                // launch vscode with the workspace
                this._launchVSCode([uri]);

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

        try {

            if (!GLib.file_test(this._recentWorkspacesPath, GLib.FileTest.EXISTS | GLib.FileTest.IS_DIR)) {
                throw new Error('Recent workspaces directory does not exist');
            }
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
            recentWorkspacesDir.enumerate_children_async('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (file, res) => {

                const iter = recentWorkspacesDir.enumerate_children_finish(res);

                try {

                    let info: Gio.FileInfo | null;

                    while ((info = iter.next_file(null)) !== null) {
                        const file = iter.get_child(info);
                        if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
                            continue;
                        }

                        log(`Deleting ${file.get_path()}`);
                        file.delete(null);
                    }

                    iter.close_async(GLib.PRIORITY_DEFAULT, null, (_iter, res) => {
                        try {
                            _iter?.close_finish(res);
                        } catch (error) {
                            logError((error as object), 'Failed to close iterator');
                        }
                    });
                } catch (error) {
                    logError((error as object), 'Failed to delete recent workspaces');
                }
            });

            // Purge the cache
            this._workspaces.clear();
            this._recentWorkspaces.clear();

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