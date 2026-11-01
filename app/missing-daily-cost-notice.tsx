import type { MissingDailyCost } from "./channel-financials";

export function MissingDailyCostNotice({ items, start, end }: { items: MissingDailyCost[]; start: string; end: string }) {
  if (!items.length) return null;
  const channels = [...new Set(items.map(item => item.channel))];
  return <article className="elapsedCostAlert" role="alert">
    <strong>هزینهٔ روزانه ثبت نشده است</strong>
    <p>کنترل از <b dir="ltr">{start}</b> تا <b dir="ltr">{end}</b>، شامل خودِ روز پایان و حداکثر تا امروز است. روزهای آینده بررسی نمی‌شوند.</p>
    <ul>{channels.map(channel => <li key={channel}><b>{channel}</b><span>{items.filter(item => item.channel === channel).map(item => item.date).join("، ")}</span></li>)}</ul>
    <p>در بخش «بودجه و هزینه»، مبلغ این روزها را وارد و ذخیره کنید. اگر هزینه‌ای نداشته‌اید، عدد 0 را ثبت کنید؛ خانهٔ خالی با صفر یکسان نیست. جمعه‌ها طبق قاعدهٔ فعلی روز کاری محسوب نمی‌شوند.</p>
  </article>;
}
