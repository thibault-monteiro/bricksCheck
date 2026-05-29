// Shared constants. Loaded as a classic script in popup/options, and imported
// dynamically by the service worker (ES module).

export const DEFAULT_OPTIONS = {
  enabled: false,
  intervalMinutes: 1,
  ownedThreshold: 100,
  projectThresholdOverrides: {},
  notifyWhenBelowThreshold: true,
  playSoundOnNotification: false,
  autopilotEnabled: false,
  autoConfirmInvestmentPlan: false
};

export const AUTH_TOKEN_KEY = "bricksAuthToken";
export const API_ORIGIN = "https://api.bricks.co";
export const APP_ORIGIN = "https://app.bricks.co";
