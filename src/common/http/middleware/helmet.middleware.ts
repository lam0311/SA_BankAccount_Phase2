import helmet, { HelmetOptions } from "helmet";

/**
 * Cấu hình Helmet bảo mật HTTP Response Headers toàn cục (TSK-12):
 * - hidePoweredBy: loại bỏ header X-Powered-By (vá cảnh báo OWASP ZAP Alert 10037).
 * - xFrameOptions: DENY (chống Clickjacking).
 * - xContentTypeOptions: nosniff (mặc định Helmet - chống MIME-sniffing).
 * - strictTransportSecurity (HSTS): ép HTTPS (mặc định Helmet).
 * - contentSecurityPolicy (CSP): chống XSS, vẫn cho phép Swagger UI hoạt động bình thường.
 */
export function createHelmetOptions(): HelmetOptions {
  return {
    hidePoweredBy: true,
    xFrameOptions: { action: "deny" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "validator.swagger.io"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  };
}

export const helmetMiddleware = helmet(createHelmetOptions());
