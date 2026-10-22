// Opening and saving sketches. Chromium browsers support the File System Access API,
// which lets Save write back to the same file; elsewhere we fall back to a file
// input for opening and a download for saving.

type WritableFile = { write(data: string): Promise<void>; close(): Promise<void> };

export type SketchFileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<WritableFile>;
};

type PickerType = { description: string; accept: Record<string, string[]> };

type FilePickerWindow = Window & {
  showOpenFilePicker?(options: { types: PickerType[]; multiple?: boolean }): Promise<SketchFileHandle[]>;
  showSaveFilePicker?(options: { suggestedName: string; types: PickerType[] }): Promise<SketchFileHandle>;
};

export const sketchExtensions = [".ino", ".cpp", ".c", ".h", ".hpp", ".txt"];

const pickerTypes: PickerType[] = [
  { description: "Arduino sketch", accept: { "text/plain": sketchExtensions } },
];

export const emptySketch = `void setup() {
  // put your setup code here, to run once:

}

void loop() {
  // put your main code here, to run repeatedly:

}
`;

export function isPickerCancel(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function supportsFilePickers() {
  return typeof (window as FilePickerWindow).showOpenFilePicker === "function";
}

// Returns undefined when the user cancels.
export async function pickSketchFile(): Promise<{ handle: SketchFileHandle; text: string } | undefined> {
  const picker = (window as FilePickerWindow).showOpenFilePicker;
  if (!picker) {
    return undefined;
  }
  try {
    const [handle] = await picker({ types: pickerTypes, multiple: false });
    return { handle, text: await (await handle.getFile()).text() };
  } catch (error) {
    if (isPickerCancel(error)) {
      return undefined;
    }
    throw error;
  }
}

// Saves to `handle` when possible, otherwise asks where to save (or downloads).
// Returns the handle written to, null for a plain download, or undefined if cancelled.
export async function saveSketchFile(
  text: string,
  name: string,
  handle?: SketchFileHandle,
): Promise<SketchFileHandle | null | undefined> {
  try {
    let target = handle;
    const savePicker = (window as FilePickerWindow).showSaveFilePicker;
    if (!target?.createWritable && savePicker) {
      target = await savePicker({ suggestedName: name, types: pickerTypes });
    }
    if (target?.createWritable) {
      const writable = await target.createWritable();
      await writable.write(text);
      await writable.close();
      return target;
    }
  } catch (error) {
    if (isPickerCancel(error)) {
      return undefined;
    }
    throw error;
  }

  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return null;
}
