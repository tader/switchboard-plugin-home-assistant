import type { AccountInfo, AuthMethod, Connection, Field, PluginContext } from './api.d.ts';
type Cfg = Record<string, any>;
interface Options {
    id?: string;
    name?: string;
    description?: string;
    unavailable?: string;
    /** Extra fields asked besides the secret(s). */
    fields?: Field[];
    /** Label and help for the secret field. */
    secretLabel?: string;
    secretDescription?: string;
    /** Validates the credentials and tells who they belong to. Throw to reject them. */
    identify?(credentials: Record<string, string>, config: Cfg): Promise<AccountInfo | undefined> | AccountInfo | undefined;
}
export declare function bearerToken(o?: Options): AuthMethod;
export declare function headerKey(o?: Options & {
    header?: string;
    prefix?: string;
}): AuthMethod;
export declare function queryKey(o?: Options & {
    param?: string;
}): AuthMethod;
export declare function basicAuth(o?: Options & {
    usernameLabel?: string;
    usernameDescription?: string;
}): AuthMethod;
export default function setup(_ctx: PluginContext): {
    services: {
        id: string;
        name: string;
        description: string;
        icon: string;
        baseUrl: (conn: Connection) => any;
        allowedHosts: (conn: Connection) => string[];
        openapi: (conn: Connection) => any;
        authMethods: AuthMethod[];
    }[];
    exports: {
        bearerToken: typeof bearerToken;
        headerKey: typeof headerKey;
        queryKey: typeof queryKey;
        basicAuth: typeof basicAuth;
    };
};
export {};
