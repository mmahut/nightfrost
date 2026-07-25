use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;

/// Error envelope.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub status_code: u16,
    pub error: String,
    pub message: String,
}

impl ApiError {
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status_code: 404,
            error: "Not Found".into(),
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status_code: 400,
            error: "Bad Request".into(),
            message: message.into(),
        }
    }

    pub fn gone(message: impl Into<String>) -> Self {
        Self {
            status_code: 410,
            error: "Gone".into(),
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status_code: 500,
            error: "Internal Server Error".into(),
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status =
            StatusCode::from_u16(self.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self)).into_response()
    }
}
