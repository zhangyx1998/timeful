/**
 * The prompts, driven both ways: scripted keypresses against a stdin that
 * claims to be a terminal, and scripted lines against one that does not.
 *
 * No test here touches the real stdin, and none of them can hang: a prompt
 * with no answer left either ends the input (which is an error) or fails the
 * test by timing out.
 */
import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { CliError } from "./errors.ts";
import {
  CancelledError,
  InputEndedError,
  confirm,
  isInteractive,
  select,
  text,
  type Tty,
} from "./tui.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const CTRL_C = "\x03";

/** A stdin that says it is a terminal, plus a record of what was drawn. */
function fakeTty() {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  input.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    rawModes.push(mode);
  };

  const written: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  }) as Writable & { columns?: number };
  output.columns = 80;

  const io: Tty = { input, output };
  return {
    io,
    rawModes,
    text: () => written.join(""),
    /** Sends keys once the prompt is listening for them. */
    async press(...keys: string[]) {
      for (const key of keys) {
        await settle();
        input.write(key);
      }
      await settle();
    },
    /** Types a whole line, for the text prompt behind an "Other…" row. */
    type: (line: string) => input.write(line),
    end: () => input.end(),
  };
}

/**
 * A stdin that is a pipe, answering one prompt at a time. Answers are fed
 * reactively: a prompt is the only output with no trailing newline, and an
 * answer written before its question would be swallowed by readline's buffer.
 */
function scripted(answers: string[], endWhenExhausted = false) {
  const queue = [...answers];
  const input = new PassThrough();
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const line = String(chunk);
      written.push(line);
      if (line.endsWith("\n")) return callback();
      const next = queue.shift();
      if (next === undefined) {
        if (endWhenExhausted) setImmediate(() => input.end());
        return callback();
      }
      setImmediate(() => input.write(`${next}\n`));
      callback();
    },
  });
  return { io: { input, output } as Tty, text: () => written.join("") };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const COLOURS = [
  { value: "red", label: "red", hint: "the warm one" },
  { value: "green", label: "green" },
  { value: "blue", label: "blue" },
];

describe("isInteractive", () => {
  it("needs both a TTY and a way into raw mode", () => {
    expect(isInteractive(fakeTty().io)).toBe(true);
    expect(isInteractive(scripted([]).io)).toBe(false);
  });
});

describe("select, by keypress", () => {
  it("moves with the arrow keys and confirms with Enter", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS });
    await tty.press(DOWN, DOWN, UP, ENTER);

    expect(await answer).toBe("green");
    // The chosen row is summarised; the list itself is rubbed out.
    expect(tty.text()).toContain("Pick one");
    expect(tty.text()).toContain("green");
  });

  it("takes j and k as well, and wraps around", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS });
    await tty.press("k", ENTER);
    expect(await answer).toBe("blue");
  });

  it("jumps to a row by number", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS });
    await tty.press("3", ENTER);
    expect(await answer).toBe("blue");
  });

  it("starts on the row it was told to", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS, initial: 2 });
    await tty.press(ENTER);
    expect(await answer).toBe("blue");
  });

  it("draws the hint and the key help", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS });
    await tty.press(ENTER);
    await answer;
    expect(tty.text()).toContain("the warm one");
    expect(tty.text()).toContain("Enter to select");
    expect(tty.text()).toContain("Ctrl+C to cancel");
  });

  it("hides the cursor and restores the terminal afterwards", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS });
    await tty.press(ENTER);
    await answer;

    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.text()).toContain("\x1b[?25l");
    expect(tty.text()).toContain("\x1b[?25h");
  });

  it("switches to a text answer when 'Other…' is chosen", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, {
      message: "Pick one",
      options: COLOURS,
      other: { label: "Other…", prompt: "Name it", parse: (raw) => raw.toUpperCase() },
    });
    await tty.press(DOWN, DOWN, DOWN, ENTER);
    await settle();
    tty.type("purple\n");

    expect(await answer).toBe("PURPLE");
    expect(tty.text()).toContain("Name it");
  });

  it("re-asks when the typed answer is rejected", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, {
      message: "Pick one",
      options: COLOURS,
      other: {
        label: "Other…",
        prompt: "Name it",
        parse: (raw) => {
          if (raw === "beige") throw new CliError("beige is not a colour");
          return raw;
        },
      },
    });
    await tty.press("4", ENTER);
    await settle();
    tty.type("beige\n");
    await settle();
    tty.type("teal\n");

    expect(await answer).toBe("teal");
    expect(tty.text()).toContain("beige is not a colour");
  });

  it("restores the terminal and reports 130 on Ctrl+C", async () => {
    const tty = fakeTty();
    // The handler goes on before the keys do: the rejection lands mid-press.
    const failure = select(tty.io, { message: "Pick one", options: COLOURS }).catch(
      (err: unknown) => err,
    );
    await tty.press(DOWN, CTRL_C);

    const err = await failure;
    expect(err).toBeInstanceOf(CancelledError);
    expect(err).toMatchObject({ code: 130 });
    // A terminal left in raw mode after the process exits is unusable.
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.text()).toContain("\x1b[?25h");
  });

  it("fails instead of hanging when the input ends", async () => {
    const tty = fakeTty();
    const answer = select(tty.io, { message: "Pick one", options: COLOURS });
    await settle();
    tty.end();
    await expect(answer).rejects.toThrow(InputEndedError);
  });
});

describe("select, by line", () => {
  it("takes the number of a row", async () => {
    const io = scripted(["2"]);
    expect(await select(io.io, { message: "Pick one", options: COLOURS })).toBe("green");
    expect(io.text()).toContain("1) red");
    expect(io.text()).toContain("3) blue");
  });

  it("takes the label of a row, whatever its case", async () => {
    const io = scripted(["BLUE"]);
    expect(await select(io.io, { message: "Pick one", options: COLOURS })).toBe("blue");
  });

  it("takes the default when the answer is empty", async () => {
    const io = scripted([""]);
    expect(await select(io.io, { message: "Pick one", options: COLOURS, initial: 1 })).toBe(
      "green",
    );
    expect(io.text()).toContain("Choice [green]");
  });

  it("treats anything unrecognised as the 'Other…' answer", async () => {
    const io = scripted(["10.0.0.1"]);
    const answer = await select(io.io, {
      message: "Pick one",
      options: COLOURS,
      other: { label: "Other…", prompt: "Name it", parse: (raw) => `parsed:${raw}` },
    });
    expect(answer).toBe("parsed:10.0.0.1");
  });

  it("re-asks when there is no 'Other…' to fall back on", async () => {
    const io = scripted(["mauve", "9", "red"]);
    expect(await select(io.io, { message: "Pick one", options: COLOURS })).toBe("red");
    expect(io.text()).toContain("'mauve' is not one of the choices");
    expect(io.text()).toContain("Choose a number between 1 and 3");
  });

  it("fails instead of hanging when the input ends", async () => {
    const io = scripted([], true);
    await expect(select(io.io, { message: "Pick one", options: COLOURS })).rejects.toThrow(
      InputEndedError,
    );
  });
});

describe("confirm", () => {
  it("answers on one keypress", async () => {
    const tty = fakeTty();
    const answer = confirm(tty.io, { message: "Sure?", default: false });
    await tty.press("y");
    expect(await answer).toBe(true);
    expect(tty.text()).toContain("Sure? (y/N)");
    expect(tty.text()).toContain("yes");
  });

  it("takes Enter as the default", async () => {
    const tty = fakeTty();
    const answer = confirm(tty.io, { message: "Sure?", default: true });
    await tty.press(ENTER);
    expect(await answer).toBe(true);
  });

  it("ignores keys that are neither", async () => {
    const tty = fakeTty();
    const answer = confirm(tty.io, { message: "Sure?", default: true });
    await tty.press("q", "z", "n");
    expect(await answer).toBe(false);
  });

  it("cancels on Ctrl+C", async () => {
    const tty = fakeTty();
    const failure = confirm(tty.io, { message: "Sure?", default: true }).catch(
      (err: unknown) => err,
    );
    await tty.press(CTRL_C);
    expect(await failure).toBeInstanceOf(CancelledError);
  });

  it("re-asks a pipe until it says y or n", async () => {
    const io = scripted(["maybe", "n"]);
    expect(await confirm(io.io, { message: "Sure?", default: true })).toBe(false);
    expect(io.text()).toContain("Please answer y or n.");
  });
});

describe("text", () => {
  it("offers a default and takes it when the answer is empty", async () => {
    const io = scripted([""]);
    expect(await text(io.io, { message: "Port", default: "3000" })).toBe("3000");
    expect(io.text()).toContain("Port [3000]: ");
  });

  it("re-asks until the answer validates", async () => {
    const io = scripted(["nope", "8080"]);
    const answer = await text(io.io, {
      message: "Port",
      default: "3000",
      validate: (value) => {
        if (!/^\d+$/.test(value)) throw new CliError(`'${value}' is not a number`);
      },
    });
    expect(answer).toBe("8080");
    expect(io.text()).toContain("'nope' is not a number");
  });
});
