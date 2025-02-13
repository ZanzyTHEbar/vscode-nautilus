import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
import '@girs/gnome-shell/gio';
import '@girs/gnome-shell/meta';
import '@girs/gnome-shell/shell';
import '@girs/gnome-shell/st';
import '@girs/gnome-shell/ui/main';
import '@girs/gnome-shell/ui/panelMenu';
import '@girs/gnome-shell/ui/popupMenu';

declare const global: {
    get_pointer: () => [number, number, number];
};