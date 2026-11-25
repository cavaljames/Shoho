use crate::model::Data;
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Timelike};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct ReportDay {
    pub date: String,
    pub total: u64,
    pub count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSlot {
    pub label: &'static str,
    pub start_hour: u32,
    pub total: u64,
    pub count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousMonth {
    pub year: i32,
    pub month: u32,
    pub average: u64,
    pub change_percent: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyReport {
    pub year: i32,
    pub month: u32,
    pub goal: u32,
    pub days_in_month: u32,
    pub elapsed_days: u32,
    pub total: u64,
    pub average: u64,
    pub active_days: u32,
    pub goal_days: u32,
    pub longest_streak: u32,
    pub record_count: u32,
    pub previous: Option<PreviousMonth>,
    pub days: Vec<ReportDay>,
    pub time_slots: Vec<TimeSlot>,
    pub insights: Vec<String>,
}

pub fn monthly_report(
    data: &Data,
    year: i32,
    month: u32,
    at: i64,
) -> Result<MonthlyReport, String> {
    let now = Local
        .timestamp_millis_opt(at)
        .single()
        .ok_or("当前时间无效。")?;
    calculate(data, year, month, now)
}

fn month_days(year: i32, month: u32) -> Option<u32> {
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }?;
    Some(next.pred_opt()?.day())
}

// Use calendar dates in the system timezone, rather than fixed 24-hour intervals.
// The timezone parameter also lets boundary tests run independently of the host.
fn calculate<Tz: TimeZone>(
    data: &Data,
    year: i32,
    month: u32,
    now: DateTime<Tz>,
) -> Result<MonthlyReport, String> {
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) {
        return Err("请选择有效的年月。".into());
    }
    if (year, month) > (now.year(), now.month()) {
        return Err("暂时不能查看未来月份。".into());
    }
    if data.settings.goal == 0 {
        return Err("每日目标无效。".into());
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1).ok_or("月份无效。")?;
    let days_in_month = month_days(year, month).ok_or("月份无效。")?;
    let elapsed_days = if (year, month) == (now.year(), now.month()) {
        now.day()
    } else {
        days_in_month
    };
    let previous_date = first.pred_opt().filter(|date| date.year() >= 1970);
    let mut previous_total = 0_u64;
    let mut days: Vec<_> = (1..=days_in_month)
        .map(|day| ReportDay {
            date: format!("{year:04}-{month:02}-{day:02}"),
            total: 0,
            count: 0,
        })
        .collect();
    let mut time_slots: Vec<_> = ["凌晨", "上午", "下午", "晚上"]
        .into_iter()
        .enumerate()
        .map(|(index, label)| TimeSlot {
            label,
            start_hour: index as u32 * 6,
            total: 0,
            count: 0,
        })
        .collect();
    let timezone = now.timezone();
    for record in &data.records {
        if record.at > now.timestamp_millis() || record.amount == 0 {
            continue;
        }
        let Some(date) = timezone.timestamp_millis_opt(record.at).single() else {
            continue;
        };
        if (date.year(), date.month()) == (year, month) {
            let day = &mut days[(date.day() - 1) as usize];
            day.total += u64::from(record.amount);
            day.count += 1;
            let slot = &mut time_slots[(date.hour() / 6) as usize];
            slot.total += u64::from(record.amount);
            slot.count += 1;
        } else if previous_date.is_some_and(|previous| {
            (date.year(), date.month()) == (previous.year(), previous.month())
        }) {
            previous_total += u64::from(record.amount);
        }
    }
    let total: u64 = days.iter().map(|day| day.total).sum();
    let record_count = days.iter().map(|day| day.count).sum();
    let average = (total + u64::from(elapsed_days) / 2) / u64::from(elapsed_days);
    let active_days = days.iter().filter(|day| day.count > 0).count() as u32;
    let goal_days = days
        .iter()
        .filter(|day| day.total >= u64::from(data.settings.goal))
        .count() as u32;
    let (mut streak, mut longest_streak) = (0, 0);
    for day in &days {
        streak = if day.count > 0 { streak + 1 } else { 0 };
        longest_streak = longest_streak.max(streak);
    }
    let previous = previous_date.filter(|_| previous_total > 0).map(|date| {
        let previous_days = date.day();
        let previous_average = previous_total as f64 / f64::from(previous_days);
        let change = ((total as f64 / f64::from(elapsed_days)) / previous_average - 1.0) * 100.0;
        PreviousMonth {
            year: date.year(),
            month: date.month(),
            average: (previous_total + u64::from(previous_days) / 2) / u64::from(previous_days),
            change_percent: (change * 10.0).round() / 10.0,
        }
    });
    let mut insights = Vec::new();
    if record_count > 0 {
        insights.push(format!(
            "已在 {active_days} 天记录饮水，最长连续 {longest_streak} 天。"
        ));
        let peak_total = time_slots.iter().map(|slot| slot.total).max().unwrap_or(0);
        let peaks: Vec<_> = time_slots
            .iter()
            .filter(|slot| slot.total == peak_total)
            .collect();
        if peaks.len() == 1 && record_count >= 3 {
            let slot = peaks[0];
            let percent = (slot.total * 100 + total / 2) / total;
            insights.push(format!(
                "{}（{:02}:00–{:02}:00）记录的水量最多，占 {percent}%。",
                slot.label,
                slot.start_hour,
                slot.start_hour + 6
            ));
        } else if let Some(best) = days
            .iter()
            .filter(|day| day.count > 0)
            .max_by_key(|day| day.total)
        {
            insights.push(format!(
                "{} 的记录水量最多，共 {} ml。",
                best.date, best.total
            ));
        }
    }
    Ok(MonthlyReport {
        year,
        month,
        goal: data.settings.goal,
        days_in_month,
        elapsed_days,
        total,
        average,
        active_days,
        goal_days,
        longest_streak,
        record_count,
        previous,
        days,
        time_slots,
        insights,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Record;
    use chrono::FixedOffset;

    fn zone() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }
    fn at(year: i32, month: u32, day: u32, hour: u32) -> DateTime<FixedOffset> {
        zone()
            .with_ymd_and_hms(year, month, day, hour, 0, 0)
            .single()
            .unwrap()
    }
    fn add(data: &mut Data, amount: u32, date: DateTime<FixedOffset>) {
        data.records.push(Record {
            id: format!("report-{}", data.records.len()),
            amount,
            at: date.timestamp_millis(),
            label: Some("一杯".into()),
        });
    }
    #[test]
    fn empty_current_month_has_finite_statistics_and_no_future_penalty() {
        let now = at(2026, 11, 25, 12);
        let data = Data::new(now.timestamp_millis());
        let report = calculate(&data, 2026, 11, now).unwrap();
        assert_eq!((report.days_in_month, report.elapsed_days), (30, 25));
        assert_eq!(
            (
                report.total,
                report.average,
                report.goal_days,
                report.longest_streak
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(report.days.len(), 30);
        assert!(report.previous.is_none());
        assert!(report.insights.is_empty());
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["elapsedDays"], 25);
        assert!(json["previous"].is_null());
        assert_eq!(json["timeSlots"][0]["startHour"], 0);
    }
    #[test]
    fn averages_include_unrecorded_days_and_goals_use_daily_totals() {
        let now = at(2026, 11, 7, 12);
        let mut data = Data::new(now.timestamp_millis());
        data.settings.goal = 1000;
        for (day, amount) in [(1, 200), (3, 1000), (4, 1000), (6, 1000), (6, 1000)] {
            add(&mut data, amount, at(2026, 11, day, 10));
        }
        let before = serde_json::to_value(&data).unwrap();
        let report = calculate(&data, 2026, 11, now).unwrap();
        assert_eq!((report.total, report.average), (4200, 600));
        assert_eq!(
            (
                report.active_days,
                report.goal_days,
                report.longest_streak,
                report.record_count
            ),
            (4, 3, 2, 5)
        );
        assert_eq!((report.days[5].total, report.days[5].count), (2000, 2));
        assert!(report.days[7..].iter().all(|day| day.total == 0));
        assert_eq!(
            serde_json::to_value(&data).unwrap(),
            before,
            "Reports must not modify saved data"
        );
        data.settings.goal = 2000;
        assert_eq!(calculate(&data, 2026, 11, now).unwrap().goal_days, 1);
    }
    #[test]
    fn local_midnight_and_future_timestamps_do_not_leak_between_months() {
        let now = at(2026, 3, 1, 1);
        let mut data = Data::new(now.timestamp_millis());
        add(&mut data, 200, at(2026, 2, 28, 23));
        add(&mut data, 350, at(2026, 3, 1, 0));
        add(&mut data, 500, at(2026, 3, 1, 2));
        add(&mut data, 1000, at(2026, 4, 1, 0));
        let report = calculate(&data, 2026, 3, now).unwrap();
        assert_eq!((report.total, report.record_count), (350, 1));
        assert_eq!(report.days[0].date, "2026-03-01");
        assert_eq!(report.time_slots[0].total, 350);
        assert_eq!(calculate(&data, 2026, 2, now).unwrap().total, 200);
    }
    #[test]
    fn leap_years_and_complete_months_use_calendar_lengths() {
        let now = at(2026, 11, 25, 12);
        let data = Data::new(now.timestamp_millis());
        for (year, month, length) in [(2024, 2, 29), (2025, 2, 28), (2026, 4, 30), (2026, 10, 31)] {
            let report = calculate(&data, year, month, now).unwrap();
            assert_eq!(report.days_in_month, length);
            assert_eq!(report.elapsed_days, length);
            assert_eq!(report.days.len(), length as usize);
        }
    }
    #[test]
    fn comparison_uses_unrounded_daily_averages_and_handles_year_rollover() {
        let now = at(2026, 1, 2, 12);
        let mut data = Data::new(now.timestamp_millis());
        add(&mut data, 310, at(2025, 12, 31, 23));
        add(&mut data, 100, at(2026, 1, 1, 10));
        let report = calculate(&data, 2026, 1, now).unwrap();
        let previous = report.previous.unwrap();
        assert_eq!(
            (previous.year, previous.month, previous.average),
            (2025, 12, 10)
        );
        assert_eq!(previous.change_percent, 400.0);
        data.records[0].amount = 300;
        assert_eq!(
            calculate(&data, 2026, 1, now)
                .unwrap()
                .previous
                .unwrap()
                .change_percent,
            416.7
        );
    }
    #[test]
    fn missing_previous_month_does_not_invent_a_percentage() {
        let now = at(2026, 11, 25, 12);
        let mut data = Data::new(now.timestamp_millis());
        add(&mut data, 200, at(2026, 11, 5, 10));
        add(&mut data, 500, at(2026, 9, 5, 10));
        assert!(calculate(&data, 2026, 11, now).unwrap().previous.is_none());
    }
    #[test]
    fn hour_boundaries_and_named_record_compatibility_cover_all_24_hours() {
        let now = at(2026, 11, 25, 12);
        let mut data = Data::new(now.timestamp_millis());
        for hour in [0, 5, 6, 11, 12, 17, 18, 23] {
            add(&mut data, 200, at(2026, 11, 5, hour));
        }
        data.records[0].label = None;
        let report = calculate(&data, 2026, 11, now).unwrap();
        assert_eq!(report.total, 1600);
        assert!(report
            .time_slots
            .iter()
            .all(|slot| slot.total == 400 && slot.count == 2));
        assert_eq!(
            report.time_slots.iter().map(|slot| slot.total).sum::<u64>(),
            report.total
        );
        assert!(
            !report.insights.iter().any(|line| line.contains("占")),
            "Equal slots have no dominant period"
        );
    }
    #[test]
    fn invalid_requests_are_rejected_without_panics() {
        let now = at(2026, 11, 25, 12);
        let data = Data::new(now.timestamp_millis());
        for (year, month) in [
            (2026, 0),
            (2026, 13),
            (1969, 12),
            (i32::MAX, 1),
            (2026, 12),
            (2027, 1),
        ] {
            assert!(calculate(&data, year, month, now).is_err());
        }
        assert!(monthly_report(&data, 2026, 11, i64::MAX).is_err());
    }
    #[test]
    fn system_timezone_month_boundary_including_dst_months() {
        let now = Local
            .with_ymd_and_hms(2026, 11, 25, 12, 0, 0)
            .single()
            .unwrap();
        let mut data = Data::new(now.timestamp_millis());
        for day in [1, 2, 3] {
            data.records.push(Record {
                id: format!("local-{day}"),
                amount: 200,
                at: Local
                    .with_ymd_and_hms(2026, 11, day, 0, 0, 0)
                    .single()
                    .unwrap()
                    .timestamp_millis(),
                label: None,
            });
        }
        let report = monthly_report(&data, 2026, 11, now.timestamp_millis()).unwrap();
        assert_eq!(
            (report.total, report.longest_streak, report.elapsed_days),
            (600, 3, 25)
        );
    }
}
