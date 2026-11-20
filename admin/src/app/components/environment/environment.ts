// Production values. `ng serve` / development builds swap this file for
// environment.development.ts (see fileReplacements in angular.json).
export enum Environment {
  production = 'true',
  API_URL    = 'https://pos.pantheras.io', // API URL
  appDomain  = 'pos.pantheras.io', // App Domain
  payDomain  = 'pos.pantheras.io', // Payment Domain
}
