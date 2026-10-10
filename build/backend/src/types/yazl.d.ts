// The part of yazl 3.3.1 (https://github.com/thejoshwolfe/yazl) this backend uses.
// Declared here instead of @types/yazl, which pulls a second, newer @types/node.
declare module "yazl" {
  import type { Readable } from "node:stream";

  export interface FileOptions {
    mtime: Date;
    mode: number;
    compress: boolean;
  }

  export class ZipFile {
    outputStream: Readable;
    addFile(realPath: string, metadataPath: string, options?: Partial<FileOptions>): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: Partial<FileOptions>): void;
    addEmptyDirectory(metadataPath: string, options?: Partial<Pick<FileOptions, "mtime" | "mode">>): void;
    end(options?: { comment?: string }): void;
    on(event: "error", listener: (err: Error) => void): this;
  }
}
