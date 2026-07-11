/**
 * Spec §2.2 canonical selector order and §2.3 conjunction canonical form.
 */
import { describe, expect, it } from "vitest";
import {
  Conjunction,
  compareSelectors,
  equality,
  interval,
  isNull,
  negated,
  printSelector,
  type Selector,
  selectorKey,
} from "../../src/index.js";

describe("canonical selector order (spec §2.2)", () => {
  const inOrder: Selector[] = [
    equality("age", false), // bool < number < string at same attr+kind
    equality("age", 5),
    equality("age", 7),
    equality("age", "5"),
    isNull("age"),
    interval("age", Number.NEGATIVE_INFINITY, 3),
    interval("age", 1, 2),
    interval("age", 1, 3),
    interval("age", 2, 3),
    negated(equality("age", 5)),
    negated(isNull("age")),
    equality("sex", "female"),
    equality("sex", "male"),
    isNull("sex"),
    negated(equality("sex", "female")),
  ];

  it("compareSelectors is consistent with the documented order", () => {
    for (let i = 0; i < inOrder.length; i++) {
      for (let j = 0; j < inOrder.length; j++) {
        const got = Math.sign(compareSelectors(inOrder[i]!, inOrder[j]!));
        expect(got, `${selectorKey(inOrder[i]!)} vs ${selectorKey(inOrder[j]!)}`).toBe(
          Math.sign(i - j),
        );
      }
    }
  });

  it("keys are unique and stable", () => {
    const keys = inOrder.map(selectorKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("negation attribute = inner attribute (sorts adjacent to its attribute)", () => {
    expect(compareSelectors(negated(equality("age", 5)), equality("sex", "male"))).toBeLessThan(0);
  });
});

describe("conjunction canonical form (spec §2.3)", () => {
  it("sorts and dedupes selectors", () => {
    const c = new Conjunction([
      equality("sex", "male"),
      equality("age", 5),
      equality("sex", "male"),
    ]);
    expect(c.depth).toBe(2);
    expect(c.selectors.map(selectorKey)).toEqual([
      selectorKey(equality("age", 5)),
      selectorKey(equality("sex", "male")),
    ]);
  });

  it("prints in the reference display dialect (string-sorted, ' AND ')", () => {
    // interval() without column context: integral JS numbers print as Python
    // ints ("35"); space builders override via loInt/hiInt from the column.
    const c = new Conjunction([equality("Sex", "female"), interval("Age", 28.5, 35)]);
    expect(c.toString()).toBe("Age: [28.50:35[ AND Sex=='female'");
    expect(c.toString("query")).toBe("(Age: [28.5:35[ and Sex=='female')");
    const cFloat = new Conjunction([interval("Age", 28.5, 35, { hiInt: false })]);
    expect(cFloat.toString()).toBe("Age: [28.50:35.0[");
    expect(new Conjunction([]).toString()).toBe("Dataset");
    expect(new Conjunction([]).toString("query")).toBe("True");
  });

  it("equality on float-typed numbers prints Python-style", () => {
    expect(printSelector(equality("x", 5, false))).toBe("x==5.0");
    expect(printSelector(equality("x", 5, true))).toBe("x==5");
    expect(printSelector(equality("x", true))).toBe("x==True");
    expect(printSelector(negated(equality("x", 1, true)), "query")).toBe("(not x==1)");
    expect(printSelector(negated(equality("x", 1, true)), "display")).toBe("NOT x==1");
  });
});
