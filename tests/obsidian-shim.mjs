export class TAbstractFile {}
export class TFile extends TAbstractFile {
  constructor(path, stat = { mtime: Date.now(), size: 0 }) {
    super();
    this.path = path;
    this.stat = stat;
  }
}
export class TFolder extends TAbstractFile {}

export function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

export const notices = [];
export class Notice {
  constructor(message) {
    notices.push(message);
  }
  setMessage() {}
  hide() {}
}

export class Modal {
  constructor(app) {
    this.app = app;
  }
  open() {}
  close() {}
}

export class Setting {}
export function setIcon() {}
export async function requestUrl() {
  throw new Error("Network is not available in tests");
}

export const Platform = { isMobile: false, isPhone: false };
