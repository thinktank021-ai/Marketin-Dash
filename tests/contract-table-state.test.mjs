import assert from "node:assert/strict";
import test from "node:test";

import { applyDetailedContractDelta } from "../app/contract-table-state.ts";

test("upper contract total increments immediately after create and decrements after delete", () => {
  const initial = [{
    expert: "کارشناس آزمون",
    calls: 12,
    sheetContracts: 2,
    hasLegacyAggregate: true,
    legacyContractCount: 3,
    detailedContractCount: 0,
    resolvedContractCount: 3,
  }];

  const afterCreate = applyDetailedContractDelta(initial, "کارشناس آزمون", 1);
  assert.equal(afterCreate[0].detailedContractCount, 1);
  assert.equal(afterCreate[0].resolvedContractCount, 4, "visible upper-table total must increment immediately");
  assert.equal(initial[0].resolvedContractCount, 3, "state update must be immutable");

  const afterDelete = applyDetailedContractDelta(afterCreate, "کارشناس آزمون", -1);
  assert.equal(afterDelete[0].detailedContractCount, 0);
  assert.equal(afterDelete[0].resolvedContractCount, 3, "visible total must return to its legacy value");
});

test("removing the last detailed override falls back to Sheet contracts", () => {
  const rows = [{
    expert: "بدون سابقه",
    calls: 7,
    sheetContracts: 2,
    hasLegacyAggregate: false,
    legacyContractCount: 0,
    detailedContractCount: 1,
    resolvedContractCount: 1,
  }];
  const result = applyDetailedContractDelta(rows, "بدون سابقه", -1);
  assert.equal(result[0].resolvedContractCount, 2);
});
