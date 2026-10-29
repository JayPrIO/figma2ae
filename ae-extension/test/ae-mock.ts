/**
 * A small, behaviour-faithful mock of the After Effects ExtendScript DOM — enough to execute
 * the compiled ES3 builder in a Node VM and inspect what it creates.
 *
 * Fidelity notes (mirrors AE semantics the builder depends on):
 *  - comp.layers.add* inserts at index 1 (top of the stack)
 *  - collections are 1-based (`items[1]`, `layer(1)`)
 *  - property(matchName) on groups lazily materialises known children (AE's fixed groups)
 *  - setParentWithJump does not alter transform values
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

/* eslint-disable @typescript-eslint/no-explicit-any */

export class MockProp {
  /** fonts considered installed (font substitution simulation); undefined = all installed */
  static installedFonts: string[] | undefined;
  children: MockProp[] = [];
  value: any = undefined;
  enabled = true;
  name: string;
  constructor(
    readonly matchName: string,
    public parentProperty: MockProp | null = null,
  ) {
    this.name = matchName;
  }
  get numProperties(): number {
    return this.children.length;
  }
  property(key: string | number): MockProp {
    if (typeof key === 'number') return this.children[key - 1];
    let c = this.children.find((p) => p.matchName === key || p.name === key);
    if (!c) {
      c = new MockProp(key, this);
      this.children.push(c);
    }
    return c;
  }
  addProperty(matchName: string): MockProp {
    const c = new MockProp(matchName, this);
    this.children.push(c);
    return c;
  }
  setValue(v: any): void {
    if (v instanceof MockTextDocument) {
      const styles: any[] = [v, ...v.ranges.map((r) => r.style)];
      for (const st of styles) if (st.tracking !== undefined && !Number.isInteger(st.tracking)) throw new Error(`After Effects error: Unable to set "tracking". ${st.tracking} is not an integer.`);
    }
    const fonts = MockProp.installedFonts;
    if (fonts && v instanceof MockTextDocument && fonts.indexOf(v.font) === -1) v.font = 'ArialMT';
    this.value = v;
  }
  moveTo(i: number): void {
    const sib = this.parentProperty!.children;
    sib.splice(sib.indexOf(this), 1);
    sib.splice(i - 1, 0, this);
  }
  /** test helper: find descendants by matchName */
  all(matchName: string): MockProp[] {
    const out: MockProp[] = [];
    const walk = (p: MockProp): void => {
      for (const c of p.children) {
        if (c.matchName === matchName) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export interface AeEnv {
  context: vm.Context;
  app: any;
  project: any;
  F2AE: any;
  comps(): MockComp[];
  footage(): any[];
  version: string;
}

export class MockTextDocument {
  text = '';
  font = 'ArialMT';
  fontSize = 12;
  fillColor = [0, 0, 0];
  applyFill = true;
  applyStroke = false;
  tracking = 0;
  leading = 0;
  autoLeading = true;
  justification: any = 0;
  boxTextPos: number[] | undefined;
  ranges: { start: number; end: number; style: any }[] = [];
  resetCharStyle(): void {}
  resetParagraphStyle(): void {}
}

export class MockLayer extends MockProp {
  enabledLayer = true;
  comment = '';
  parent: MockLayer | null = null;
  blendingMode = 'NORMAL';
  trackMatteType = 0;
  trackMatteLayer: MockLayer | null = null;
  selected = false;
  constructor(
    readonly kind: 'shape' | 'null' | 'text' | 'av',
    readonly containingComp: MockComp,
    readonly source: any = null,
  ) {
    super('layer');
  }
  get index(): number {
    return this.containingComp.stack.indexOf(this) + 1;
  }
  setParentWithJump(p: MockLayer): void {
    if (p.containingComp !== this.containingComp) throw new Error('parent must be in the same comp');
    this.parent = p;
  }
  setTrackMatte(m: MockLayer, t: number): void {
    if (m.containingComp !== this.containingComp) throw new Error('matte must be in the same comp');
    this.trackMatteLayer = m;
    this.trackMatteType = t;
  }
  remove(): void {
    const st = this.containingComp.stack;
    st.splice(st.indexOf(this), 1);
  }
  sourceRectAtTime(): { top: number; left: number; width: number; height: number } {
    return { top: -18, left: 0, width: 80, height: 22 };
  }
  // AE uses `enabled` on layers; MockProp also has `enabled` — alias for clarity in tests
  get visible(): boolean {
    return this.enabled;
  }
  transformValue(m: string): any {
    return this.property('ADBE Transform Group').property(m).value;
  }
}

export class MockComp {
  stack: MockLayer[] = [];
  comment = '';
  parentFolder: any = null;
  selectedLayers: MockLayer[] = [];
  openedInViewer = false;
  constructor(
    public name: string,
    public width: number,
    public height: number,
    public pixelAspect: number,
    public duration: number,
    public frameRate: number,
  ) {}
  get layers(): any {
    const comp = this;
    const push = (l: MockLayer): MockLayer => {
      comp.stack.unshift(l);
      return l;
    };
    return {
      get length() {
        return comp.stack.length;
      },
      addShape: () => push(new MockLayer('shape', comp)),
      addNull: () => push(new MockLayer('null', comp)),
      addText: () => push(textLayer(comp, null)),
      addBoxText: (size: number[]) => push(textLayer(comp, size)),
      add: (item: any) => push(new MockLayer('av', comp, item)),
    };
  }
  get numLayers(): number {
    return this.stack.length;
  }
  layer(i: number): MockLayer {
    return this.stack[i - 1];
  }
  openInViewer(): void {
    this.openedInViewer = true;
  }
}

function textLayer(comp: MockComp, box: number[] | null): MockLayer {
  const l = new MockLayer('text', comp);
  const doc = new MockTextDocument();
  if (box) doc.boxTextPos = [-box[0] / 2, -box[1] / 2];
  (doc as any).box = box;
  l.property('ADBE Text Properties').property('ADBE Text Document').value = doc;
  return l;
}

export interface MockOptions {
  version?: string;
  characterRange?: boolean;
  fonts?: boolean;
  /** missing fonts: requested names not in this list get substituted */
  installedFonts?: string[];
}

export function createAe(code: string, opts: MockOptions = {}): AeEnv {
  const version = opts.version ?? '25.0x12';
  class CompItem extends MockComp {}
  class FolderItem {
    parentFolder: any = null;
    comment = '';
    constructor(public name: string) {}
  }
  class FootageItem {
    parentFolder: any = null;
    comment = '';
    name: string;
    constructor(
      public file: string,
      public width: number,
      public height: number,
    ) {
      this.name = file.split('/').pop()!;
    }
  }
  const list: any[] = [];
  const items: any = {
    get length() {
      return list.length;
    },
    addComp: (name: string, w: number, h: number, par: number, dur: number, fps: number) => {
      if (!(w >= 4 && h >= 4)) throw new Error(`addComp: invalid size ${w}x${h}`);
      const c = new CompItem(name, w, h, par, dur, fps);
      list.push(c);
      sync();
      return c;
    },
    addFolder: (name: string) => {
      const f = new FolderItem(name);
      list.push(f);
      sync();
      return f;
    },
  };
  const sync = (): void => {
    list.forEach((it, i) => (items[i + 1] = it));
  };

  const project = {
    items,
    activeItem: null as any,
    importFile: (io: any) => {
      // derive pixel size from the file name convention "<w>x<h>" or default 100x50
      const m = /(\d+)x(\d+)/.exec(io.file.fsName);
      const f = new FootageItem(io.file.fsName, m ? Number(m[1]) : 100, m ? Number(m[2]) : 50);
      list.push(f);
      sync();
      return f;
    },
  };

  const textDocProto = MockTextDocument.prototype as any;
  if (opts.characterRange !== false) {
    textDocProto.characterRange = function (this: MockTextDocument, start: number, end: number) {
      const style: any = {};
      this.ranges.push({ start, end, style });
      return style;
    };
  } else {
    delete textDocProto.characterRange;
  }

  const installed = opts.installedFonts;
  const app: any = {
    version,
    project,
    undoGroups: [] as string[],
    beginUndoGroup(n: string) {
      app.undoGroups.push(`begin:${n}`);
    },
    endUndoGroup() {
      app.undoGroups.push('end');
    },
    newProject() {},
    findMenuCommandId: (n: string) => n,
    executeCommand(cmd: string) {
      if (cmd === 'Inner Shadow') {
        for (const c of list) if (c instanceof MockComp) for (const l of c.stack) if (l.selected) l.property('ADBE Layer Styles').property('innerShadow/enabled');
      }
    },
    fonts:
      opts.fonts === false
        ? undefined
        : {
            getFontsByFamilyNameAndStyleName: (f: string, s: string) => [{ postScriptName: `${f.replace(/\s/g, '')}-${s.replace(/\s/g, '')}` }],
          },
  };

  MockProp.installedFonts = installed;

  class File {
    encoding = 'UTF-8';
    private mode = '';
    private buf = '';
    constructor(readonly fsName: string) {}
    get exists(): boolean {
      return existsSync(this.fsName);
    }
    open(mode: string): boolean {
      this.mode = mode;
      if (mode === 'r') {
        if (!this.exists) return false;
        this.buf = readFileSync(this.fsName, 'utf8');
      }
      return true;
    }
    read(): string {
      return this.buf;
    }
    write(s: string): void {
      this.buf += s;
    }
    close(): void {
      if (this.mode === 'w') writeFileSync(this.fsName, this.buf);
    }
  }
  class ImportOptions {
    constructor(readonly file: File) {}
  }
  class Shape {
    vertices: number[][] = [];
    inTangents: number[][] = [];
    outTangents: number[][] = [];
    closed = true;
  }

  const sandbox: any = {
    app,
    File,
    Folder: class {},
    ImportOptions,
    Shape,
    CompItem,
    FolderItem,
    FootageItem,
    BlendingMode: { NORMAL: 'NORMAL', MULTIPLY: 'MULTIPLY', SCREEN: 'SCREEN', OVERLAY: 'OVERLAY', LINEAR_DODGE: 'LINEAR_DODGE' },
    TrackMatteType: { NO_TRACK_MATTE: 0, ALPHA: 1, ALPHA_INVERTED: 2, LUMA: 3, LUMA_INVERTED: 4 },
    ParagraphJustification: { LEFT_JUSTIFY: 'L', CENTER_JUSTIFY: 'C', RIGHT_JUSTIFY: 'R', FULL_JUSTIFY_LASTLINE_LEFT: 'J' },
  };
  sandbox.$ = { global: sandbox };
  // ExtendScript has no JSON: hide the VM's so the eval fallback path is what we test.
  const context = vm.createContext(sandbox);
  vm.runInContext('delete this.JSON;', context);
  vm.runInContext(code, context, { filename: 'f2ae.jsx' });

  return {
    context,
    app,
    project,
    F2AE: sandbox.F2AE,
    version,
    comps: () => list.filter((x) => x instanceof MockComp) as MockComp[],
    footage: () => list.filter((x) => x instanceof FootageItem),
  };
}
