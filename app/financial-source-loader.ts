export async function readFinancialSource<T>(load: () => Promise<Response>, valid: (value: T) => boolean): Promise<{ data: T | null; pending: boolean }> {
  try {
    const response = await load();
    const data = await response.json() as T & { pending?: boolean; reason?: string };
    if (!response.ok || !valid(data)) return { data: null, pending: data.pending === true || data.reason === "service_account_not_configured" };
    return { data, pending: false };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { data: null, pending: false };
  }
}
