export type PayPalOperationType =
  | 'CREATE_ORDER'
  | 'AUTHORIZE'
  | 'CAPTURE'
  | 'VOID'
  | 'REFUND';

export type PayPalOperationStatus =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNCERTAIN';

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalOrderItem {
  name: string;
  unit_amount: PayPalMoney;
  quantity: string;
  sku?: string;
  category?: 'DIGITAL_GOODS' | 'PHYSICAL_GOODS' | 'DONATION';
  description?: string;
}

export interface PayPalAuthorizationResource {
  id: string;
  status: string;
  amount?: PayPalMoney;
  create_time?: string;
  update_time?: string;
  expiration_time?: string;
  links?: PayPalLink[];
}

export interface PayPalCaptureResource {
  id: string;
  status: string;
  amount?: PayPalMoney;
  final_capture?: boolean;
  create_time?: string;
  update_time?: string;
  links?: PayPalLink[];
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  description?: string;
  amount?: {
    currency_code: string;
    value: string;
    breakdown?: {
      item_total?: PayPalMoney;
    };
  };
  items?: PayPalOrderItem[];
  payments?: {
    authorizations?: PayPalAuthorizationResource[];
    captures?: PayPalCaptureResource[];
  };
}

export interface PayPalOrderResource {
  id: string;
  status: string;
  intent: string;
  purchase_units?: PayPalPurchaseUnit[];
  links?: PayPalLink[];
  create_time?: string;
  update_time?: string;
}

export interface PayPalOAuthResponse {
  scope?: string;
  access_token: string;
  token_type: string;
  app_id?: string;
  expires_in: number;
  nonce?: string;
}

export interface PayPalErrorDetail {
  field?: string;
  value?: string;
  location?: string;
  issue?: string;
  description?: string;
}

export interface PayPalErrorPayload {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  error?: string;
  error_description?: string;
}

export class PayPalApiError extends Error {
  public readonly httpStatus: number;
  public readonly paypalName?: string;
  public readonly debugId?: string;
  public readonly details?: PayPalErrorDetail[];
  public readonly rawPayload?: unknown;

  constructor(
    message: string,
    options: {
      httpStatus: number;
      paypalName?: string;
      debugId?: string;
      details?: PayPalErrorDetail[];
      rawPayload?: unknown;
    }
  ) {
    super(message);
    this.name = 'PayPalApiError';
    this.httpStatus = options.httpStatus;
    this.paypalName = options.paypalName;
    this.debugId = options.debugId;
    this.details = options.details;
    this.rawPayload = options.rawPayload;
  }
}

export class PayPalUncertainOutcomeError extends Error {
  public readonly operationId: string;
  public readonly paypalRequestId: string;

  constructor(message: string, operationId: string, paypalRequestId: string) {
    super(message);
    this.name = 'PayPalUncertainOutcomeError';
    this.operationId = operationId;
    this.paypalRequestId = paypalRequestId;
  }
}

export class PayPalIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalIdempotencyConflictError';
  }
}

export class PayPalOrderVerificationError extends Error {
  public readonly checks: Array<{ name: string; passed: boolean; detail: string }>;

  constructor(
    message: string,
    checks: Array<{ name: string; passed: boolean; detail: string }>
  ) {
    super(message);
    this.name = 'PayPalOrderVerificationError';
    this.checks = checks;
  }
}

export interface PaymentOperationRow {
  id: string;
  session_id: string;
  proposal_id: string;
  payment_id: string | null;
  operation_type: PayPalOperationType;
  logical_operation_key: string;
  paypal_request_id: string;
  request_payload_hash: string;
  operation_status: PayPalOperationStatus;
  http_status: number | null;
  paypal_resource_id: string | null;
  paypal_response_json: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  session_id: string;
  proposal_id: string;
  reference_id: string;
  custom_id: string;
  currency: string;
  expected_amount_cents: number;
  items_payload_hash: string;
  paypal_order_id: string | null;
  paypal_order_status: string | null;
  paypal_intent: string | null;
  payer_action_url: string | null;
  paypal_authorization_id: string | null;
  paypal_authorization_status: string | null;
  paypal_capture_id: string | null;
  paypal_capture_status: string | null;
  paypal_void_status: string | null;
  verification_status: string;
  verification_notes_json: string | null;
  last_paypal_snapshot_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderVerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface OrderVerificationResult {
  verified: boolean;
  itemsVerificationMode:
    | 'PAYPAL_RETURNED_ITEMS_VERIFIED'
    | 'LOCAL_HASH_ONLY_ITEMS_NOT_RETURNED_BY_PAYPAL';
  checks: OrderVerificationCheck[];
  order: PayPalOrderResource;
}

