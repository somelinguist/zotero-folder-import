declare const Zotero: any
declare const Components: any
declare const ZoteroPane_Local: any
declare const OS: any

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/*
const marker = 'FolderImportMonkeyPatched'
function patch(object, method, patcher) {
  if (object[method][marker]) return
  object[method] = patcher(object[method])
  object[method][marker] = true
}
*/

function debug(msg) {
  Zotero.debug(`folder-import: ${msg}`)
}

class FilePicker { // minimal shim of Zotero FilePicker -- replace with actual picker on merge
  public modeGetFolder: number = Components.interfaces.nsIFilePicker.modeGetFolder

  public returnOK: number = Components.interfaces.nsIFilePicker.returnOK
  public returnCancel: number = Components.interfaces.nsIFilePicker.Cancel

  public file: any = null

  private fp: any

  constructor() {
    this.fp = Components.classes['@mozilla.org/filepicker;1'].createInstance(Components.interfaces.nsIFilePicker)
  }

  public init(parent: Window, title: string, mode: number) {
    this.fp.init(parent, title, mode)
  }

  public show(): Promise<number> {
    return new Zotero.Promise(resolve => { // eslint-disable-line @typescript-eslint/no-unsafe-return
      this.fp.open(userChoice => {
        switch (userChoice) {
          case Components.interfaces.nsIFilePicker.returnOK:
          case Components.interfaces.nsIFilePicker.returnReplace:
            this.file = this.fp.file
            resolve(Components.interfaces.nsIFilePicker.returnOK)
            break

          default:
            resolve(Components.interfaces.nsIFilePicker.returnCancel)
            break
        }
      })
    })
  }
}

class FolderScanner {
  files: string[] = []
  folders: FolderScanner[] = []
  extensions: Set<string> = new Set

  path: string
  name: string

  constructor(path, isRoot) {
    debug(`scanning ${path}`)
    this.path = path
    this.name = isRoot ? '' : OS.Path.basename(path)
  }

  public async scan() {
    const iterator = new OS.File.DirectoryIterator(this.path)
    await iterator.forEach(entry => {
      debug(`entry: ${JSON.stringify(Object.keys(entry))} ${JSON.stringify(entry)}`)
      if (entry.isDir) {
        debug(`${this.path}: subdir ${JSON.stringify(entry.name)}`)
        this.folders.push(new FolderScanner(OS.Path.join(this.path, entry.name), false))
      }
      else {
        debug(`${this.path}: file ${JSON.stringify(entry.name)}`)
        debug(OS.Path.join(this.path, entry.name))
        this.files.push(OS.Path.join(this.path, entry.name))
        const ext = this.extension(entry.name)
        if (ext) this.extensions.add(ext.toLowerCase())
      }
    })
    iterator.close()

    await Promise.all(this.folders.map(dir => dir.scan()))
    for (const dir of this.folders) {
      this.extensions = new Set([...this.extensions, ...dir.extensions])
    }
    debug(`scanned ${this.path}: ${JSON.stringify(Array.from(this.extensions))}`)
  }

  public selected(extensions) {
    let selected = this.files.filter(f => extensions.has(this.extension(f))).length
    for (const folder of this.folders) {
      selected += folder.selected(extensions)
    }
    return selected
  }

  public async import(params, collection, pdfs) {
    // don't do anything if no selected extensions exist in this folder
    if (! [...this.extensions].find(ext => params.extensions.has(ext))) return

    debug(`importing path ${this.path}`)

    if (this.name) {
      const existing = (collection ? collection.getChildCollections() : Zotero.Collections.getByLibrary(params.libraryID)).find(child => child.name === this.name)

      if (existing) {
        debug(`${this.name} exists under ${collection ? collection.name : 'the selected library'}`)
        collection = existing
      }
      else {
        // eslint-disable-next-line @typescript-eslint/restrict-plus-operands, prefer-template
        debug(`${this.name} does not exist, creating${collection ? ' under ' + collection.name : ''}`)
        const parentKey = collection ? collection.key : undefined
        collection = new Zotero.Collection
        collection.libraryID = params.libraryID
        collection.name = this.name
        collection.parentKey = parentKey
        await collection.saveTx()
        debug(`${this.name} created`)
        await sleep(10) // eslint-disable-line @typescript-eslint/no-magic-numbers
        debug(`${this.name} loaded`)
      }
    }
    if (collection) await collection.loadAllData()

    for (const file of this.files.sort()) {
      if (!params.extensions.has(this.extension(file))) continue

      try {
        if (params.link) {
          debug(`linking ${file} into ${collection ? collection.name : '<root>'}`)
          await Zotero.Attachments.linkFromFile({
            file,
            parentItemID: false,
            collections: collection ? [ collection.id ] : undefined,
          })
        }
        else if (!file.endsWith('.lnk')) {
          debug(`importing ${file} into ${collection ? collection.name : '<root>'}`)
          const item = await Zotero.Attachments.importFromFile({
            file,
            libraryID: params.libraryID,
            collections: collection ? [ collection.id ] : undefined,
          })
          if (file.toLowerCase().endsWith('.pdf')) pdfs.push(item)
        }
      }
      catch (err) {
        debug(err)
      }

      await sleep(10) // eslint-disable-line @typescript-eslint/no-magic-numbers
      params.progress.update()
    }

    for (const folder of this.folders) {
      await folder.import(params, collection, pdfs)
    }
  }

  private extension(path): false | string {
    const name = OS.Path.basename(path)
    if (name[0] === '.') return false
    const parts: string[] = name.split('.')
    return parts.length > 1 ? parts[parts.length - 1] : false
  }
}

class FolderImport {
  private initialized = false
  private status: { total: number, done: number }
  private globals: Record<string, any> = {}

  private load(globals: Record<string, any>) {
    this.globals = globals

    if (!this.globals.document.getElementById('zotero-tb-add-folder')) {
      // temporary hack because I can't overlay without an id
      const toolbarbutton = this.globals.document.getElementById('zotero-tb-add')
      const menupopup = toolbarbutton.querySelector('menupopup')
      const menuseparators = Array.from(menupopup.querySelectorAll('menuseparator'))
      const menuseparator = menuseparators[menuseparators.length - 1]
      const menuitem = this.globals.document.createElement('menuitem')
      menuitem.setAttribute('label', 'Add Files from Folder…')
      menuitem.setAttribute('tooltiptext', '')
      menuitem.setAttribute('id', 'zotero-tb-add-folder')
      menuitem.addEventListener('command', this.addAttachmentsFromFolder.bind(this), false)
      menupopup.insertBefore(menuitem, menuseparator)
    }

    if (this.initialized) return
    this.initialized = true
  }

  public update() {
    this.status.done += 1
    const total = `${this.status.total}`
    const done = `${this.status.done}`.padStart(total.length)
    const msg = `Imported ${done}/${total}...`
    debug(msg)
    // const label = Zotero.getActiveZoteroPane().document.getElementById('zotero-pane-progress-label')
    // if (label) label.value = msg
    Zotero.updateZoteroPaneProgressMeter(Math.min((this.status.done * 100) / this.status.total, 100)) // eslint-disable-line @typescript-eslint/no-magic-numbers
  }

  public async addAttachmentsFromFolder() {
    await Zotero.Schema.schemaUpdatePromise

    if (!ZoteroPane_Local.canEdit()) {
      ZoteroPane_Local.displayCannotEditLibraryMessage()
      return
    }
    if (!ZoteroPane_Local.canEditFiles()) {
      ZoteroPane_Local.displayCannotEditLibraryFilesMessage()
      return
    }

    const fp = new FilePicker()
    fp.init(window, Zotero.getString('pane.item.attachments.select'), fp.modeGetFolder)
    if (await fp.show() !== fp.returnOK) return
    debug(`dir picked: ${fp.file.path}`)

    Zotero.showZoteroPaneProgressMeter('Scanning for attachments...')
    const root = new FolderScanner(fp.file.path, true)
    await root.scan()
    Zotero.hideZoteroPaneOverlays()

    debug(`scan complete: ${JSON.stringify(Array.from(root.extensions))} (${root.extensions.size})`)
    if (root.extensions.size) {
      const collectionTreeRow = ZoteroPane_Local.getCollectionTreeRow()
      const params = {
        link: !collectionTreeRow.isWithinGroup() && !collectionTreeRow.isPublications(),
        extensions: root.extensions,
        libraryID: collectionTreeRow.ref.libraryID,
        progress: this,
      };
      // TODO: warn for .lnk files when params.link === false
      (window as any).openDialog('chrome://zotero-folder-import/content/import.xul', '', 'chrome,dialog,centerscreen,modal', params)
      if (params.extensions.size) {
        const pdfs = []
        Zotero.showZoteroPaneProgressMeter('Importing attachments...', true)
        this.status = { total: root.selected(params.extensions), done: 0 }
        await root.import(params, ZoteroPane_Local.getSelectedCollection(), pdfs)
        Zotero.hideZoteroPaneOverlays()
        if (pdfs.length) {
          Zotero.showZoteroPaneProgressMeter('Fetching metadata for attachments...')
          Zotero.RecognizePDF.autoRecognizeItems(pdfs)
          Zotero.hideZoteroPaneOverlays()
        }
      }
    }
  }
}

Zotero.FolderImport = new FolderImport
