/// 按实际外框和工作区定位，兼容副屏负坐标。
pub fn window_position(origin: (i32, i32), area: (u32, u32), size: (u32, u32), current: Option<(i32, i32)>, margin: u32) -> (i32, i32) {
    let limits = |origin: i32, available: u32, size: u32| {
        let space = available.saturating_sub(size);
        let padding = margin.min(space / 2);
        (i64::from(origin) + i64::from(padding), i64::from(origin) + i64::from(space - padding))
    };
    let (left, right) = limits(origin.0, area.0, size.0);
    let (top, bottom) = limits(origin.1, area.1, size.1);
    let (x, y) = current.map(|(x, y)| (i64::from(x), i64::from(y))).unwrap_or((right, top));
    (x.clamp(left, right) as i32, y.clamp(top, bottom) as i32)
}

/// 先扣除标题栏和边框，避免内容挤出工作区。
pub fn inner_size(desired: (u32, u32), area: (u32, u32), frame: (u32, u32), margin: u32) -> (u32, u32) {
    let fit = |wanted: u32, available: u32, frame: u32| {
        wanted.min(available.saturating_sub(frame).saturating_sub(margin.saturating_mul(2)).max(1))
    };
    (fit(desired.0, area.0, frame.0), fit(desired.1, area.1, frame.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn starts_top_right_at_each_scale() {
        for scale in [1.0_f64, 1.25, 1.5] {
            let margin = (12.0 * scale).round() as u32;
            let width = (420.0 * scale).round() as u32 + 16;
            let height = (420.0 * scale).round() as u32 + 39;
            assert_eq!(window_position((0, 0), (1920, 1040), (width, height), None, margin), ((1920 - width - margin) as i32, margin as i32));
        }
    }
    #[test]
    fn keeps_dragged_position() {
        assert_eq!(window_position((0, 0), (1920, 1040), (436, 619), Some((200, 100)), 12), (200, 100));
    }
    #[test]
    fn respects_negative_monitor_and_top_taskbar() {
        assert_eq!(window_position((-1920, 40), (1920, 1040), (436, 459), None, 12), (-448, 52));
    }
    #[test]
    fn clamps_tall_page_and_off_screen_position() {
        assert_eq!(inner_size((630, 1230), (1920, 1040), (16, 39), 18), (630, 965));
        assert_eq!(window_position((0, 0), (1920, 1040), (646, 1004), Some((1700, 800)), 18), (1256, 18));
    }
    #[test]
    fn tiny_work_area_does_not_panic() {
        assert_eq!(window_position((0, 0), (200, 100), (436, 459), None, 12), (0, 0));
        assert_eq!(inner_size((420, 420), (20, 20), (16, 39), 12), (1, 1));
    }
}
