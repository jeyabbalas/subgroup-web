import { describe, expect, it } from "vitest";
import { CsvError, fromCSV, parseCsvRecords } from "../../src/index.js";

describe("parseCsvRecords (RFC-4180 subset)", () => {
  it("parses simple rows with LF and CRLF", () => {
    expect(parseCsvRecords("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsvRecords("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with commas, escaped quotes, and newlines", () => {
    expect(parseCsvRecords('name,q\n"Braund, Mr. Owen",yes\n')).toEqual([
      ["name", "q"],
      ["Braund, Mr. Owen", "yes"],
    ]);
    expect(parseCsvRecords('a\n"say ""hi"""\n')).toEqual([["a"], ['say "hi"']]);
    expect(parseCsvRecords('a,b\n"line1\nline2",x\n')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("preserves empty fields and trailing empty field", () => {
    expect(parseCsvRecords("a,b,c\n1,,3\n,,\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["", "", ""],
    ]);
  });

  it("rejects malformed input with line context", () => {
    expect(() => parseCsvRecords('a\nfo"o\n')).toThrow(CsvError);
    expect(() => parseCsvRecords('a\n"unterminated\n')).toThrow(CsvError);
    expect(() => parseCsvRecords("a\rb\n")).toThrow(CsvError);
  });

  it("skips blank records at start/middle/consecutive/CRLF (pandas skip_blank_lines)", () => {
    expect(parseCsvRecords("\na,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsvRecords("a,b\n1,2\n\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsvRecords("a,b\n1,2\n\n\n\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsvRecords("a,b\r\n1,2\r\n\r\n3,4\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it('quoted "" stays a real single-field record; whitespace-only lines are not blank', () => {
    expect(parseCsvRecords('a\nx\n""\ny\n')).toEqual([["a"], ["x"], [""], ["y"]]);
    // Divergence from pandas (which also skips whitespace-only lines):
    // exact-match, no trimming — spec §1.3.
    expect(parseCsvRecords("a\nx\n   \ny\n")).toEqual([["a"], ["x"], ["   "], ["y"]]);
  });

  it('text after a closing quote concatenates: "x"y → xy (pandas parity)', () => {
    expect(parseCsvRecords('a,b\n"x"y,2\n')).toEqual([
      ["a", "b"],
      ["xy", "2"],
    ]);
  });
});

describe("fromCSV inference (spec §1.3)", () => {
  it("infers integer, float, boolean, categorical", () => {
    const t = fromCSV("i,f,b,c\n1,1.5,True,x\n-2,2,False,y\n3,.5,True,x\n");
    expect(t.column("i")).toMatchObject({ kind: "numeric", integerLike: true });
    expect(t.column("f")).toMatchObject({ kind: "numeric", integerLike: false });
    expect(t.column("b").kind).toBe("boolean");
    expect(t.column("c").kind).toBe("categorical");
    expect([...(t.column("i") as { values: Float64Array }).values]).toEqual([1, -2, 3]);
  });

  it("NA tokens produce NA and demote integer columns to float-like", () => {
    const t = fromCSV("i,c\n1,x\n,y\n3,NA\n");
    const col = t.column("i") as { kind: "numeric"; values: Float64Array; integerLike: boolean };
    expect(col.integerLike).toBe(false); // pandas: int64 + NA -> float64
    expect(Number.isNaN(col.values[1]!)).toBe(true);
    expect(t.isNA("c", 2)).toBe(true);
    expect(t.value("c", 0)).toBe("x");
  });

  it("scientific notation is numeric (pandas parity)", () => {
    const t = fromCSV("x\n1e3\n2.5e-2\n");
    expect(t.column("x")).toMatchObject({ kind: "numeric", integerLike: false });
    expect([...(t.column("x") as { values: Float64Array }).values]).toEqual([1000, 0.025]);
  });

  it("overrides force kinds; bad forces are CsvErrors with context", () => {
    const t = fromCSV("x\n1\n2\n", { overrides: { x: "categorical" } });
    expect(t.column("x").kind).toBe("categorical");
    expect(() => fromCSV("x\nfoo\n", { overrides: { x: "numeric" } })).toThrow(CsvError);
  });

  it("rejects ragged rows, duplicate headers, and empty input", () => {
    expect(() => fromCSV("a,b\n1\n")).toThrow(CsvError);
    expect(() => fromCSV("a,a\n1,2\n")).toThrow(CsvError);
    expect(() => fromCSV("")).toThrow(CsvError);
    expect(() => fromCSV("a,b\n")).toThrow(CsvError);
  });

  it("custom naTokens replace the default set", () => {
    const t = fromCSV("x\nNA\n?\n1\n", { naTokens: ["?"] });
    // "NA" is a real string now -> categorical column
    expect(t.column("x").kind).toBe("categorical");
    expect(t.isNA("x", 1)).toBe(true);
    expect(t.value("x", 0)).toBe("NA");
  });

  it("blank lines vanish from tables; ragged rows still error (pandas parity)", () => {
    const t = fromCSV("a,b\n1,2\n\n3,4\n");
    expect(t.nRows).toBe(2);
    // Single-column file: blank skipped, quoted "" kept as an NA row.
    const s = fromCSV('a\nx\n\n""\ny\n');
    expect(s.nRows).toBe(3);
    expect(s.isNA("a", 1)).toBe(true);
    // `,,` is still a full 3-field record of NAs, not a blank line.
    const nas = fromCSV("a,b,c\n,,\n1,2,3\n");
    expect(nas.nRows).toBe(2);
    expect(nas.isNA("a", 0)).toBe(true);
    // Whitespace-only lines stay single-field records → ragged for 2 columns.
    expect(() => fromCSV("a,b\n1,2\n   \n")).toThrow(CsvError);
    expect(() => fromCSV("a,b\n1\n")).toThrow(CsvError);
  });
});
