let ACCESS_TOKEN = '';
let REALM_ID = '';

export function setToken(newToken: string) {
  ACCESS_TOKEN = newToken;
}

export function setRealmId(companyId: any) {
  REALM_ID = companyId;
}

export { ACCESS_TOKEN, REALM_ID };
