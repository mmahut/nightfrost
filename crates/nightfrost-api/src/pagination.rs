use serde::Deserialize;

/// Blockfrost-style pagination: ?count=1..100 (default 100), ?page>=1 (default 1),
/// ?order=asc|desc (default asc).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Pagination {
    pub count: usize,
    pub page: usize,
    pub order: Order,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    Asc,
    Desc,
}

impl Default for Pagination {
    fn default() -> Self {
        Self {
            count: 100,
            page: 1,
            order: Order::Asc,
        }
    }
}

impl Pagination {
    /// Clamp to valid ranges (Blockfrost rejects out-of-range with 400; we clamp
    /// count and require page >= 1 via validate).
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=100).contains(&self.count) {
            return Err("querystring count should be within range 1-100".into());
        }
        if self.page < 1 || self.page > 21_474_836 {
            return Err("querystring page should be within range 1-21474836".into());
        }
        Ok(())
    }

    pub fn offset(&self) -> usize {
        (self.page - 1) * self.count
    }
}
