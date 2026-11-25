import { shoho } from './bridge';
import type { MonthlyReport, Snapshot } from './types';

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing monthly report element: ${id}`);
  return node as T;
};
const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (date: Date) => `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
const number = (value: number) => value.toLocaleString('zh-CN');

export class MonthlyReportView {
  private state?: Snapshot;
  private active = false;
  private period: string | null = null;
  private request = 0;
  private lastDay = '';

  constructor(private readonly openDay: (day: string) => void, openToday: () => void) {
    element('report-prev').addEventListener('click', () => this.changeMonth(-1));
    element('report-next').addEventListener('click', () => this.changeMonth(1));
    element('report-current').addEventListener('click', () => { this.period = null; void this.load(); });
    element('report-retry').addEventListener('click', () => { void this.load(); });
    element('report-start').addEventListener('click', openToday);
  }

  update(state: Snapshot, active: boolean) {
    this.state = state;
    this.active = active;
    if (active) void this.load();
    else this.request++;
  }

  tick() {
    if (this.active && this.lastDay !== dayKey(new Date())) void this.load();
  }

  private selectedMonth() { return this.period || monthKey(new Date()); }
  private earliestMonth() {
    return this.state!.records.reduce((first, record) => {
      const key = monthKey(new Date(record.at));
      return key < first ? key : first;
    }, monthKey(new Date()));
  }
  private changeMonth(offset: number) {
    if (!this.state || !this.active) return;
    const [year, month] = this.selectedMonth().split('-').map(Number);
    const next = monthKey(new Date(year, month - 1 + offset, 1));
    if ((offset < 0 && next < this.earliestMonth()) || next > monthKey(new Date())) return;
    this.period = next === monthKey(new Date()) ? null : next;
    void this.load();
  }

  private async load() {
    if (!this.active || !this.state) return;
    const request = ++this.request;
    const selected = this.selectedMonth(), current = monthKey(new Date());
    const [year, month] = selected.split('-').map(Number);
    this.lastDay = dayKey(new Date());
    element('report-month').textContent = `${year} 年 ${month} 月`;
    element<HTMLButtonElement>('report-prev').disabled = selected <= this.earliestMonth();
    element<HTMLButtonElement>('report-next').disabled = selected >= current;
    element('report-current').hidden = selected === current;
    element('report-period').textContent = selected === current ? '本月至今' : '完整月份';
    element('monthly-report').setAttribute('aria-busy', 'true');
    element('report-loading').hidden = false;
    element('report-error').hidden = true;
    element('report-content').hidden = true;
    try {
      const report = await shoho.monthlyReport(year, month);
      // Month changes, live records and page navigation can finish out of order.
      if (request !== this.request || !this.active) return;
      this.render(report);
      element('report-content').hidden = false;
    } catch (error) {
      if (request !== this.request || !this.active) return;
      element('report-error-message').textContent = error instanceof Error ? error.message : String(error);
      element('report-error').hidden = false;
    } finally {
      if (request === this.request && this.active) {
        element('report-loading').hidden = true;
        element('monthly-report').setAttribute('aria-busy', 'false');
      }
    }
  }

  private render(report: MonthlyReport) {
    element('report-period').textContent = `${this.selectedMonth() === monthKey(new Date()) ? '截至今日' : '完整月份'} · ${report.elapsedDays} 天`;
    element('report-total').textContent = number(report.total);
    element('report-average').textContent = number(report.average);
    element('report-goal-days').textContent = `${report.goalDays} / ${report.elapsedDays}`;
    element('report-goal-metric').title = `按当前每日目标 ${number(report.goal)} ml 计算`;
    const comparison = element('report-comparison');
    comparison.hidden = report.recordCount === 0;
    if (report.previous) {
      const change = report.previous.changePercent;
      comparison.textContent = change === 0 ? '与上月日均持平' : `较上月日均 ${change > 0 ? '↑' : '↓'} ${number(Math.abs(change))}%`;
      comparison.title = `上月日均 ${number(report.previous.average)} ml；${this.selectedMonth() === monthKey(new Date()) ? '本月日均包含今天' : '按整月日均比较'}`;
    } else {
      comparison.textContent = '上月暂无记录';
      comparison.removeAttribute('title');
    }
    element('report-empty').hidden = report.recordCount > 0;
    const calendar = element('report-calendar'); calendar.replaceChildren();
    const offset = (new Date(report.year, report.month - 1, 1).getDay() + 6) % 7;
    for (let index = 0; index < offset; index++) {
      const spacer = document.createElement('span'); spacer.setAttribute('aria-hidden', 'true'); calendar.append(spacer);
    }
    report.days.forEach((day, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'report-day'; button.dataset.date = day.date;
      const future = index >= report.elapsedDays;
      button.disabled = future;
      button.dataset.level = future ? 'future' : day.total >= report.goal ? 'goal' : day.total > 0 ? 'recorded' : 'empty';
      const label = `${report.month} 月 ${index + 1} 日 · ${number(day.total)} ml${day.total >= report.goal ? ' · 已达标' : ''}`;
      button.setAttribute('aria-label', future ? `${report.month} 月 ${index + 1} 日，尚未到来` : `查看 ${label} 的记录`);
      button.title = future ? '尚未到来' : label;
      if (day.date === dayKey(new Date())) button.setAttribute('aria-current', 'date');
      const date = document.createElement('span'); date.textContent = String(index + 1);
      const amount = document.createElement('small'); amount.textContent = future ? '' : day.count > 0 ? number(day.total) : '—';
      button.append(date, amount); button.addEventListener('click', () => this.openDay(day.date)); calendar.append(button);
    });
    element('report-analysis').hidden = report.recordCount === 0;
    const insights = element('report-insights'); insights.replaceChildren();
    for (const insight of report.insights) { const line = document.createElement('p'); line.textContent = insight; insights.append(line); }
    const slots = element('report-time-slots'); slots.replaceChildren();
    for (const slot of report.timeSlots) {
      const row = document.createElement('div'); row.className = 'report-slot';
      const label = document.createElement('span'); label.textContent = `${slot.label} ${String(slot.startHour).padStart(2, '0')}–${String(slot.startHour + 6).padStart(2, '0')}`;
      const track = document.createElement('span'); track.className = 'report-slot-track';
      const bar = document.createElement('span'); bar.style.width = `${report.total ? slot.total / report.total * 100 : 0}%`; track.append(bar);
      const value = document.createElement('span'); value.textContent = `${number(slot.total)} ml`;
      row.setAttribute('aria-label', `${label.textContent}，${slot.count} 次记录，${value.textContent}`);
      row.append(label, track, value); slots.append(row);
    }
    element('report-method').textContent = `仅统计已记录水量，未记录日按 0 计。日均按 ${report.elapsedDays} 个自然日计算${this.selectedMonth() === monthKey(new Date()) ? '，包含今天' : ''}。达标按当前每日目标 ${number(report.goal)} ml 计算。环比对照上月整月日均；日期按本机时区划分。`;
  }
}
