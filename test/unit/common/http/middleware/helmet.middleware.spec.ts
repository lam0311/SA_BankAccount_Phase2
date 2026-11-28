import { IncomingMessage, ServerResponse } from 'node:http';
import { helmetMiddleware } from '@src/common/http/middleware/helmet.middleware';

describe('helmetMiddleware (TSK-12 Security Headers)', () => {
  let headers: Record<string, string>;
  let req: Partial<IncomingMessage>;
  let res: {
    setHeader: jest.Mock;
    getHeader: jest.Mock;
    removeHeader: jest.Mock;
  };

  beforeEach(() => {
    headers = {};
    req = { headers: {} };
    res = {
      setHeader: jest.fn((key: string, value: string) => {
        headers[key.toLowerCase()] = value;
      }),
      getHeader: jest.fn((key: string) => headers[key.toLowerCase()]),
      removeHeader: jest.fn((key: string) => {
        delete headers[key.toLowerCase()];
      }),
    };
  });

  it('loại bỏ hoàn toàn header X-Powered-By để tránh rò rỉ framework (Alert 10037)', (done) => {
    headers['x-powered-by'] = 'Express';

    helmetMiddleware(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      () => {
        expect(res.removeHeader).toHaveBeenCalledWith('X-Powered-By');
        expect(headers['x-powered-by']).toBeUndefined();
        done();
      },
    );
  });

  it('thiết lập X-Frame-Options: DENY để chống Clickjacking', (done) => {
    helmetMiddleware(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      () => {
        expect(headers['x-frame-options']).toBe('DENY');
        done();
      },
    );
  });

  it('thiết lập X-Content-Type-Options: nosniff để chống MIME-sniffing', (done) => {
    helmetMiddleware(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      () => {
        expect(headers['x-content-type-options']).toBe('nosniff');
        done();
      },
    );
  });

  it('thiết lập Content-Security-Policy (CSP) với các directives hợp lệ', (done) => {
    helmetMiddleware(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      () => {
        const csp = headers['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self' 'unsafe-inline'");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        done();
      },
    );
  });

  it('thiết lập Strict-Transport-Security (HSTS) để ép HTTPS', (done) => {
    helmetMiddleware(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      () => {
        const hsts = headers['strict-transport-security'];
        expect(hsts).toBeDefined();
        expect(hsts).toContain('max-age=');
        done();
      },
    );
  });
});
