/**
 * CORS Utility Module
 *
 * Provides type-safe, reusable CORS header management for the ElizaOS Overlay Sandbox.
 * Ensures consistent CORS behavior across all API endpoints.
 */

/**
 * CORS configuration interface
 */
export interface CorsConfig {
  origins: string | string[];
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders?: string[];
  maxAge?: number;
  credentials?: boolean;
}

/**
 * Default CORS configuration for the sandbox service
 */
export const DEFAULT_CORS_CONFIG: CorsConfig = {
  origins: '*', // Allow all origins for sandbox testing
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Eliza-Cloud-Key',
    'X-Request-ID',
    'X-API-Key',
  ],
  exposedHeaders: [
    'X-Eliza-Sandbox-Base-Cost-USD',
    'X-Eliza-Sandbox-Fee-USD',
    'X-Eliza-Sandbox-Total-USD',
    'X-Eliza-Cloud-Request-Id',
    'X-Request-ID',
  ],
  maxAge: 86400, // 24 hours
  credentials: false,
};

/**
 * Generates CORS headers based on configuration
 */
export function getCorsHeaders(config: CorsConfig = DEFAULT_CORS_CONFIG): Headers {
  const headers = new Headers();

  // Handle origin
  const origin = Array.isArray(config.origins)
    ? config.origins.join(', ')
    : config.origins;
  headers.set('Access-Control-Allow-Origin', origin);

  // Methods
  headers.set('Access-Control-Allow-Methods', config.methods.join(', '));

  // Allowed headers
  headers.set('Access-Control-Allow-Headers', config.allowedHeaders.join(', '));

  // Exposed headers (optional)
  if (config.exposedHeaders && config.exposedHeaders.length > 0) {
    headers.set('Access-Control-Expose-Headers', config.exposedHeaders.join(', '));
  }

  // Max age
  if (config.maxAge) {
    headers.set('Access-Control-Max-Age', config.maxAge.toString());
  }

  // Credentials
  if (config.credentials) {
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  return headers;
}

/**
 * Creates a CORS preflight response
 */
export function createCorsPreflightResponse(config: CorsConfig = DEFAULT_CORS_CONFIG): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(config),
  });
}

/**
 * Adds CORS headers to an existing response
 */
export function addCorsHeaders(response: Response, config: CorsConfig = DEFAULT_CORS_CONFIG): Response {
  const corsHeaders = getCorsHeaders(config);

  // Clone the response to avoid modifying the original
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });

  // Add CORS headers
  corsHeaders.forEach((value, key) => {
    newResponse.headers.set(key, value);
  });

  return newResponse;
}

/**
 * Creates a new response with CORS headers included
 */
export function createResponseWithCors(
  body: BodyInit | null,
  options: ResponseInit = {},
  config: CorsConfig = DEFAULT_CORS_CONFIG
): Response {
  const corsHeaders = getCorsHeaders(config);
  const headers = new Headers(options.headers);

  // Merge CORS headers with existing headers
  corsHeaders.forEach((value, key) => {
    headers.set(key, value);
  });

  return new Response(body, {
    ...options,
    headers,
  });
}

/**
 * Type-safe JSON response with CORS headers
 */
export function createJsonResponseWithCors<T>(
  data: T,
  options: Omit<ResponseInit, 'headers'> & { headers?: Record<string, string> } = {},
  config: CorsConfig = DEFAULT_CORS_CONFIG
): Response {
  const { headers = {}, ...responseOptions } = options;

  return createResponseWithCors(
    JSON.stringify(data),
    {
      ...responseOptions,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    },
    config
  );
}

/**
 * Error response with CORS headers
 */
export function createErrorResponseWithCors(
  status: number,
  error: string,
  message: string,
  config: CorsConfig = DEFAULT_CORS_CONFIG
): Response {
  return createJsonResponseWithCors(
    {
      error: {
        message,
        type: error.toLowerCase().replace(/\s+/g, '_'),
        code: status.toString(),
      },
    },
    { status },
    config
  );
}

/**
 * Validates if the request origin is allowed
 */
export function isOriginAllowed(origin: string | null, config: CorsConfig = DEFAULT_CORS_CONFIG): boolean {
  if (!origin) return true; // Allow requests without origin (like server-to-server)

  if (config.origins === '*') return true;

  if (Array.isArray(config.origins)) {
    return config.origins.includes(origin);
  }

  return config.origins === origin;
}

/**
 * Middleware-style CORS handler
 */
export function handleCorsMiddleware(
  request: Request,
  config: CorsConfig = DEFAULT_CORS_CONFIG
): Response | null {
  const origin = request.headers.get('Origin');

  // Check if origin is allowed
  if (origin && !isOriginAllowed(origin, config)) {
    return createErrorResponseWithCors(403, 'Forbidden', 'Origin not allowed', config);
  }

  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    return createCorsPreflightResponse(config);
  }

  // Not a CORS-specific request, let it through
  return null;
}