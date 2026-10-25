import { test } from "node:test";
import { strict as assert } from "node:assert";
import { label } from "./component.mjs";
test("label", () => assert.equal(label("Pi"), "Hello, Pi"));
