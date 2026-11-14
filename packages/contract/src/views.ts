/** Priority order (SPEC-013). */
export const VIEWS = [
  {
    view: "approval-card",
    uri: "ui://trusted-trade/approval-card",
    tools: ["place_order", "list_pending_approvals"],
    plainQuery: null,
    plainLoad: null,
    actions: ["decide_approval"],
  },
  {
    view: "offer-comparison",
    uri: "ui://trusted-trade/offer-comparison",
    tools: ["get_offers"],
    plainQuery: null,
    plainLoad: null,
    actions: [],
  },
  {
    view: "order-timeline",
    uri: "ui://trusted-trade/order-timeline",
    tools: ["get_order_status"],
    plainQuery: "order",
    plainLoad: "status",
    actions: [],
  },
  {
    view: "search-results",
    uri: "ui://trusted-trade/search-results",
    tools: ["search_products"],
    plainQuery: null,
    plainLoad: null,
    actions: [],
  },
  {
    view: "mandate-settings",
    uri: "ui://trusted-trade/mandate-settings",
    tools: ["get_mandate"],
    plainQuery: null,
    plainLoad: "mandate",
    actions: ["register_mandate", "revoke_mandate"],
  },
] as const;
