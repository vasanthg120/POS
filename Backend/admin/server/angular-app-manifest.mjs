
export default {
  bootstrap: () => import('./main.server.mjs').then(m => m.default),
  inlineCriticalCss: true,
  baseHref: '/',
  locale: undefined,
  routes: [
  {
    "renderMode": 2,
    "preload": [
      "chunk-OK4M3TLK.js"
    ],
    "route": "/"
  },
  {
    "renderMode": 2,
    "redirectTo": "/auth/login",
    "route": "/auth"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-FXE7F7WK.js"
    ],
    "route": "/auth/login"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-BM6NLG5E.js"
    ],
    "route": "/auth/forgot-password"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-7DT27U6K.js"
    ],
    "route": "/auth/reset-password"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-N3BW5QTG.js"
    ],
    "route": "/verify-email"
  },
  {
    "renderMode": 0,
    "preload": [
      "chunk-GP5T7OT2.js"
    ],
    "route": "/pay/*"
  },
  {
    "renderMode": 2,
    "redirectTo": "/admin/dashboard",
    "route": "/admin"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-B36JXOBI.js",
      "chunk-T7CPP6MC.js"
    ],
    "route": "/admin/dashboard"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-AA2NQN5D.js",
      "chunk-T7CPP6MC.js"
    ],
    "route": "/admin/tenants"
  },
  {
    "renderMode": 0,
    "preload": [
      "chunk-TXZBVCSK.js",
      "chunk-T7CPP6MC.js"
    ],
    "route": "/admin/tenants/*"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-6TIV4CSB.js",
      "chunk-T7CPP6MC.js"
    ],
    "route": "/admin/payments"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-BS6KVE6A.js",
      "chunk-T7CPP6MC.js"
    ],
    "route": "/admin/quotations"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-Y2QDQJHR.js"
    ],
    "route": "/admin/tracking"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-TVFBLFKW.js"
    ],
    "route": "/admin/settings"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-NZJWLAFR.js"
    ],
    "route": "/admin/margin-calculator"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-AOUIJHPJ.js",
      "chunk-AGDRPMBA.js"
    ],
    "route": "/admin/rbac"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-ZL5JZMWH.js"
    ],
    "route": "/admin/royalty"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-LQLYMSYY.js"
    ],
    "route": "/admin/billing"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-VCD4VRRG.js",
      "chunk-AGDRPMBA.js"
    ],
    "route": "/dashboard"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-AW3LCPX5.js"
    ],
    "route": "/payments"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-ER4OIANN.js"
    ],
    "route": "/quotations"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-Y2QDQJHR.js"
    ],
    "route": "/tracking"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-NZJWLAFR.js"
    ],
    "route": "/margin-calculator"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-TVFBLFKW.js"
    ],
    "route": "/settings"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-AOUIJHPJ.js",
      "chunk-AGDRPMBA.js"
    ],
    "route": "/rbac"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-ZL5JZMWH.js"
    ],
    "route": "/royalty"
  },
  {
    "renderMode": 2,
    "preload": [
      "chunk-7FTHHXKE.js"
    ],
    "route": "/billing"
  },
  {
    "renderMode": 2,
    "redirectTo": "/auth/login",
    "route": "/**"
  }
],
  entryPointToBrowserMapping: undefined,
  assets: {
    'index.csr.html': {size: 40365, hash: 'f412efc5ddb90359d9e72b5d013bf842141f6d46841f143c4f494f60dd7cb659', text: () => import('./assets-chunks/index_csr_html.mjs').then(m => m.default)},
    'index.server.html': {size: 17486, hash: '7de239bc8855abf94c793b30c4adb669e9efadbb4f006008639094ae5ac22db8', text: () => import('./assets-chunks/index_server_html.mjs').then(m => m.default)},
    'admin/dashboard/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_dashboard_index_html.mjs').then(m => m.default)},
    'admin/tenants/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_tenants_index_html.mjs').then(m => m.default)},
    'admin/settings/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_settings_index_html.mjs').then(m => m.default)},
    'admin/rbac/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_rbac_index_html.mjs').then(m => m.default)},
    'payments/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/payments_index_html.mjs').then(m => m.default)},
    'admin/billing/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_billing_index_html.mjs').then(m => m.default)},
    'auth/login/index.html': {size: 54746, hash: '04d12f362f936ef6911d5dfad8b0eb77a3a6ec9c89b103f9cc77eb66208fb4e3', text: () => import('./assets-chunks/auth_login_index_html.mjs').then(m => m.default)},
    'index.html': {size: 84772, hash: '0c72e187c37c8518cf127526abfe3cfbadb928dbb137234e1efbcf3a47deda95', text: () => import('./assets-chunks/index_html.mjs').then(m => m.default)},
    'settings/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/settings_index_html.mjs').then(m => m.default)},
    'tracking/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/tracking_index_html.mjs').then(m => m.default)},
    'royalty/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/royalty_index_html.mjs').then(m => m.default)},
    'admin/quotations/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_quotations_index_html.mjs').then(m => m.default)},
    'admin/margin-calculator/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_margin-calculator_index_html.mjs').then(m => m.default)},
    'dashboard/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/dashboard_index_html.mjs').then(m => m.default)},
    'margin-calculator/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/margin-calculator_index_html.mjs').then(m => m.default)},
    'billing/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/billing_index_html.mjs').then(m => m.default)},
    'auth/forgot-password/index.html': {size: 53312, hash: '22e9daef0606b8edd884c4bd984b3ddd577f1b84789dd4d437cbcce36c0d2e21', text: () => import('./assets-chunks/auth_forgot-password_index_html.mjs').then(m => m.default)},
    'verify-email/index.html': {size: 45951, hash: '68efd78b82414af4a9ae848a95606a4f7099dc2bbda4fd72895366f67e6ce2e8', text: () => import('./assets-chunks/verify-email_index_html.mjs').then(m => m.default)},
    'admin/royalty/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_royalty_index_html.mjs').then(m => m.default)},
    'admin/tracking/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_tracking_index_html.mjs').then(m => m.default)},
    'admin/payments/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/admin_payments_index_html.mjs').then(m => m.default)},
    'rbac/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/rbac_index_html.mjs').then(m => m.default)},
    'quotations/index.html': {size: 255, hash: '5234ad79cf291c29ba8d07c20adde4a3127024cc986f9539e639dc7c44a33e9b', text: () => import('./assets-chunks/quotations_index_html.mjs').then(m => m.default)},
    'auth/reset-password/index.html': {size: 50693, hash: '5030f5f1792265a7b2538e4268482d58d8fb86e7128d0204a630231d2ba9f555', text: () => import('./assets-chunks/auth_reset-password_index_html.mjs').then(m => m.default)},
    'styles-3QO45QSZ.css': {size: 35481, hash: 'UNS1NtuStz4', text: () => import('./assets-chunks/styles-3QO45QSZ_css.mjs').then(m => m.default)}
  },
};
