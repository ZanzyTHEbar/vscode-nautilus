NAME=vscode-workspaces
DOMAIN=prometheontechnologies.com

.PHONY: all pack install clean

all: dist/extension.js

node_modules: package.json
	pnpm install

dist/extension.js dist/prefs.js: node_modules
	tsc

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

$(NAME).zip: dist/extension.js dist/prefs.js schemas/gschemas.compiled
	@cp -r schemas dist/
	@cp stylesheet.css dist/
	@cp metadata.json dist/
	@(cd dist && zip ../$(NAME).zip -9r .)

pack: $(NAME).zip

install: $(NAME).zip
	@touch ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@echo "Extension installed. Restart GNOME Shell with Alt+F2, then 'r'. Or login again."

clean:
	@rm -rf dist node_modules $(NAME).zip

help:
	@echo "Available targets:"
	@echo "  all:    Build the extension"
	@echo "  pack:   Create a zip file with the extension"
	@echo "  install: Install the extension"
	@echo "  clean:  Remove build artifacts"
	@echo "  help:   Show this help message"

%:
	@: