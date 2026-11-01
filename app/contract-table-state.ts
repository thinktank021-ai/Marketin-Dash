export type ContractTableRow = {
  expert: string;
  calls: number;
  sheetContracts: number;
  hasLegacyAggregate: boolean;
  legacyContractCount: number;
  detailedContractCount: number;
  resolvedContractCount: number | null;
  updatedAt?: string;
};

/** Applies an acknowledged detailed-record change immediately, then the caller reconciles from the server. */
export function applyDetailedContractDelta(rows: ContractTableRow[], expert: string, delta: 1 | -1) {
  const rowIndex = rows.findIndex(row => row.expert === expert);
  if (rowIndex < 0) {
    if (delta < 0) return rows;
    return [...rows, {
      expert,
      calls: 0,
      sheetContracts: 0,
      hasLegacyAggregate: false,
      legacyContractCount: 0,
      detailedContractCount: 1,
      resolvedContractCount: 1,
    }].sort((left, right) => left.expert.localeCompare(right.expert, "fa"));
  }

  return rows.map((row, index) => {
    if (index !== rowIndex) return row;
    const detailedContractCount = Math.max(0, row.detailedContractCount + delta);
    const hasManualTotal = row.hasLegacyAggregate || detailedContractCount > 0;
    return {
      ...row,
      detailedContractCount,
      resolvedContractCount: hasManualTotal
        ? row.legacyContractCount + detailedContractCount
        : row.sheetContracts > 0 ? row.sheetContracts : null,
    };
  });
}
