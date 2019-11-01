import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable, Writable } from "readable-stream";

export class ReadAfterDestroyedError extends Error {}

export class ReadStream extends Readable {
  constructor(writeStream, name) {
    super({ autoDestroy: true });

    this._pos = 0;
    this._writeStream = writeStream;

    this.name = name;
  }

  _read(n) {
    if (this.destroyed) return;

    if (typeof this._writeStream.fd !== "number") {
      this._writeStream.once("open", () => this._read(n));
      return;
    }

    let buf = Buffer.allocUnsafe(n);
    fs.read(this._writeStream.fd, buf, 0, n, this._pos, (error, bytesRead) => {
      if (error) this.destroy(error);

      if (bytesRead) {
        this._pos += bytesRead;
        this.push(buf.slice(0, bytesRead));
        return;
      }

      if (this._writeStream._writableState.finished) {
        this.push(null);
        return;
      }

      const retry = () => {
        this._writeStream.removeListener("finish", retry);
        this._writeStream.removeListener("write", retry);
        this._read(n);
      };

      this._writeStream.addListener("finish", retry);
      this._writeStream.addListener("write", retry);
    });
  }
}

export class WriteStream extends Writable {
  constructor() {
    super({ autoDestroy: false });

    this._pos = 0;
    this._readStreams = new Set();

    this._cleanupSync = () => {
      process.removeListener("exit", this._cleanupSync);
      process.removeListener("SIGINT", this._cleanupSync);

      if (typeof this.fd === "number")
        try {
          fs.closeSync(this.fd);
        } catch (error) {
          // An error here probably means the fd was already closed, but we can
          // still try to unlink the file.
        }

      try {
        fs.unlinkSync(this.path);
      } catch (error) {
        // If we are unable to unlink the file, the operating system will clean up
        //  on next restart, since we use store thes in `os.tmpdir()`
      }
    };

    // generage a random tmp path
    crypto.randomBytes(16, (error, buffer) => {
      if (error) {
        this.destroy(error);
        return;
      }

      this.path = path.join(
        os.tmpdir(),
        `capacitor-${buffer.toString("hex")}.tmp`
      );

      // create the file
      fs.open(this.path, "wx+", this.mode, (error, fd) => {
        if (error) {
          this.destroy(error);
          return;
        }

        // cleanup when our stream closes or when the process exits
        process.addListener("exit", this._cleanupSync);
        process.addListener("SIGINT", this._cleanupSync);

        this.fd = fd;
        this.emit("open", fd);
        this.emit("ready");
      });
    });
  }

  _final(callback) {
    if (typeof this.fd !== "number") {
      this.once("open", () => this._final(callback));
      return;
    }
    callback();
  }

  _write(chunk, encoding, callback) {
    if (typeof this.fd !== "number") {
      this.once("open", () => this._write(chunk, encoding, callback));
      return;
    }
    fs.write(this.fd, chunk, 0, chunk.length, this._pos, error => {
      if (error) {
        callback(error);
        return;
      }

      this._pos += chunk.length;
      this.emit("write");
      callback();
    });
  }

  _destroy(error, callback) {
    if (typeof this.fd !== "number") {
      this.once("open", () => this._destroy(error, callback));
      return;
    }

    // Wait until all read streams have terminated before destroying this.
    this._destroyPending = () => {
      process.removeListener("exit", this._cleanupSync);
      process.removeListener("SIGINT", this._cleanupSync);

      const unlink = error => {
        fs.unlink(this.path, unlinkError => {
          // If we are unable to unlink the file, the operating system will
          // clean up on next restart, since we use store thes in `os.tmpdir()`
          this.fd = null;
          callback(unlinkError || error);
        });
      };

      if (typeof this.fd === "number")
        fs.close(this.fd, closeError => {
          // An error here probably means the fd was already closed, but we can
          // still try to unlink the file.

          unlink(closeError || error);
        });
      else callback(error);
    };

    // All read streams have terminated, so we can destroy this.
    if (this._readStreams.size === 0) this._destroyPending();
    else if (error)
      // If there is an error, destroy all read streams with the error.
      for (let readStream of this._readStreams) readStream.destroy(error);
  }

  createReadStream(name) {
    if (this.destroyed)
      throw new ReadAfterDestroyedError(
        "A ReadStream cannot be created from a destroyed WriteStream."
      );

    const readStream = new ReadStream(this, name);
    this._readStreams.add(readStream);

    const remove = () => {
      this._readStreams.delete(readStream);

      if (this._destroyPending && this._readStreams.size === 0)
        this._destroyPending();

      readStream.removeListener("end", remove);
      readStream.removeListener("close", remove);
    };

    readStream.addListener("end", remove);
    readStream.addListener("close", remove);

    return readStream;
  }
}

export default WriteStream;
