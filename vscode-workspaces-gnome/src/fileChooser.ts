import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/fileUtils.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const FileChooserDialog = (
    callback: (filePath: string) => void,
    title?: string,
    description?: string,
    styleClass?: string,
): ModalDialog.ModalDialog => {
    let fileChooser: ModalDialog.ModalDialog | null = new ModalDialog.ModalDialog({
        destroyOnClose: true,
        styleClass: 'file-chooser-dialog',
    });

    let remiderId: number | null = null;
    let closedID: number | null = fileChooser.connect('closed', () => {

        if (!remiderId) {
            remiderId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
                const openRes = fileChooser?.open();

                if (!openRes) {
                    fileChooser?.destroy();
                    return GLib.SOURCE_REMOVE;
                }

                remiderId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    });

    fileChooser.connect('destroy', () => {
        log('File Chooser Destroyed');

        if (closedID) {
            fileChooser?.disconnect(closedID);
            closedID = null;
        }

        if (remiderId) {
            GLib.source_remove(remiderId);
            remiderId = null;
        }

        fileChooser = null;
    });


    // Add content to the dialog
    const content = new Dialog.MessageDialogContent({
        title: 'Add Workspace',
        description: 'Choose a file or folder to open',
        styleClass: 'file-chooser-dialog-content',
    });

    fileChooser.contentLayout.add_child(content);

    // Add a file chooser to the dialog
    const fileChooserWidget = new St.Entry({
        style_class: 'file-chooser-dialog-entry',
    });

    fileChooser.contentLayout.add_child(fileChooserWidget);

    // Add buttons to the dialog
    fileChooser.setButtons([
        {
            action: () => {
                log('File Chooser Cancel');
                fileChooser?.destroy();
            },
            label: 'Cancel',
            default: true,
        },
        {
            action: () => {
                log('File Chooser Open');
                // grab the file path from the entry
                const filePath = fileChooserWidget.get_text();
                callback(filePath);
                fileChooser?.destroy();
            },
            label: 'Open',
        },
    ])

    return fileChooser;
}
