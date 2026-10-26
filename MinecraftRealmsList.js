// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: cube;
// Minecraft Java Realms List for Scriptable.
// Run it once inside the Scriptable app to sign in
// Run it in the app again any time to sign out (clears the saved tokens).
// Only run scripts that you trust.

// change to false if you do not want notifications
const NOTIFY = true;

const CLIENT_ID = "00000000402b5328";
const SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const KC = "mc-auth-v1"; // Keychain key
const TIMEOUT = 20; // seconds per request

//Colors for realms list
const SERVER_OPEN = "#a8c49a";
const SERVER_FULL = "#c49a9a";
const SERVER_EMPTY = "#c1c1c1";

// ---------- helpers ----------

function hostOf(url) {
    const m = /^https:\/\/([^/?#:]+)(?::443)?(?:[/?#]|$)/i.exec(url);
    return m ? m[1].toLowerCase() : null;
}

function form(obj) {
    return Object.entries(obj)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
}

function describe(status, data) {
    const parts = [`HTTP ${status ?? "?"}`];
    for (const k of ["error", "XErr", "errorType", "errorMessage"]) {
        if (data && data[k] != null)
            parts.push(`${k}=${String(data[k]).slice(0, 80)}`);
    }
    return parts.join(" ");
}

async function send(
    url,
    { method = "GET", body, json = false, headers = {} } = {},
) {
    //   await sleep(200);
    const req = new Request(url);
    req.method = method;
    req.timeoutInterval = TIMEOUT;
    let reqheaders = {
        Accept: "application/json",
        Host: hostOf(url),
        ...headers,
    };
    if (body !== undefined) {
        reqheaders["Content-Type"] = json
            ? "application/json"
            : "application/x-www-form-urlencoded";
        let reqbody = json ? JSON.stringify(body, null, 6) : form(body);
        reqheaders["Content-Length"] = Data.fromString(reqbody)
            .getBytes()
            .length.toString();
        req.body = reqbody;
    }
    req.headers = reqheaders;
    let data;
    try {
        data = await req.loadJSON();
    } catch (e) {
        data = {};
    }

    return {
        status: req.response?.statusCode,
        data: data && typeof data === "object" ? data : {},
    };
}

const post = (url, body, opts = {}) =>
    send(url, { ...opts, method: "POST", body });

function loadState() {
    if (!Keychain.contains(KC)) return {};
    try {
        return JSON.parse(Keychain.get(KC)) || {};
    } catch (e) {
        Keychain.remove(KC);
        return {};
    }
}
function saveState(s) {
    Keychain.set(KC, JSON.stringify(s));
}

// ---------- Microsoft (live.com) ----------
async function deviceCodeLogin() {
    const { status, data: dc } = await post(
        "https://login.live.com/oauth20_connect.srf",
        {
            client_id: CLIENT_ID,
            scope: SCOPE,
            response_type: "device_code",
        },
    );
    if (!dc.device_code || !dc.user_code)
        throw new Error("Could not get a device code: " + describe(status, dc));

    const signinUrl = "https://www.microsoft.com/link";

    const a = new Alert();
    a.title = "Sign in to Microsoft";
    a.message = `Your code is ${dc.user_code}\n\nIt will be copied for you. On the page that opens, paste it, sign in, then come back and tap "I've signed in".`;
    a.addAction("Copy code & open sign-in page");
    a.addCancelAction("Cancel");
    if ((await a.present()) === -1) throw new Error("Sign-in cancelled");
    Pasteboard.copyString(dc.user_code);
    Safari.open(signinUrl);

    const b = new Alert();
    b.title = "Finished signing in?";
    b.addAction("I've signed in");
    b.addCancelAction("Cancel");
    const done = await b.present();
    Pasteboard.copyString(""); // clear the code from the clipboard
    if (done === -1) throw new Error("Sign-in cancelled");

    const { status1, data } = await post(
        "https://login.live.com/oauth20_token.srf",
        {
            client_id: CLIENT_ID,
            device_code: dc.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
    );
    if (data.access_token) return data;
    throw new Error("Login failed: " + describe(status1, data));
}

async function refreshMsa(refreshToken) {
    const { status, data } = await post(
        "https://login.live.com/oauth20_token.srf",
        {
            client_id: CLIENT_ID,
            scope: SCOPE,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        },
    );
    if (!data.access_token) {
        // invalid_grant = token revoked/expired: drop it so the next in-app run asks to sign in again
        if (data.error === "invalid_grant") Keychain.remove(KC);
        throw new Error(
            "Session expired, open Scriptable and run this script to sign in again (" +
                describe(status, data) +
                ")",
        );
    }
    return data;
}

// ---------- Xbox + Minecraft ----------
async function minecraftLogin(msaAccessToken) {
    const user = await post(
        "https://user.auth.xboxlive.com/user/authenticate",
        {
            Properties: {
                AuthMethod: "RPS",
                SiteName: "user.auth.xboxlive.com",
                RpsTicket: msaAccessToken,
            },
            RelyingParty: "http://auth.xboxlive.com",
            TokenType: "JWT",
        },
        { json: true },
    );

    if (!user.data.Token)
        throw new Error(
            "Xbox user auth failed: " + describe(user.status, user.data),
        );

    const xsts = await post(
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        {
            Properties: { SandboxId: "RETAIL", UserTokens: [user.data.Token] },
            RelyingParty: "rp://api.minecraftservices.com/",
            TokenType: "JWT",
        },
        { json: true },
    );

    if (!xsts.data.Token)
        throw new Error("XSTS failed: " + describe(xsts.status, xsts.data));
    const uhs = xsts.data.DisplayClaims?.xui?.[0]?.uhs;
    if (!uhs) throw new Error("XSTS response was missing the user hash");

    const mc = await post(
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        { identityToken: `XBL3.0 x=${uhs};${xsts.data.Token}` },
        { json: true },
    );
    await show(JSON.stringify(mc), "MC");
    if (!mc.data.access_token)
        throw new Error(
            "Minecraft login failed: " + describe(mc.status, mc.data),
        );
    const ttl = Number(mc.data.expires_in) || 3600;
    return {
        token: mc.data.access_token,
        expiresAt: Date.now() + Math.max(ttl - 300, 60) * 1000,
    };
}

async function getProfile(mcToken) {
    const { status, data } = await send(
        "https://api.minecraftservices.com/minecraft/profile",
        {
            headers: { Authorization: "Bearer " + mcToken },
        },
    );
    if (status === 404)
        throw new Error("This account doesn't own Minecraft Java");
    if (status !== 200 || !data.name)
        throw new Error("Profile request failed: " + describe(status, data));
    return {
        id: data.id,
        name: data.name,
        skins: data.skins || [],
        capes: data.capes || [],
    };
}

async function getMinecraftJavaToken() {
    const s = loadState();
    if (s.mc && s.mc.expiresAt > Date.now()) return s.mc;

    let msa;
    if (s.refreshToken) {
        msa = await refreshMsa(s.refreshToken);
    } else {
        if (config.runsInWidget)
            throw new Error(
                "Open Scriptable and run this script once to sign in",
            );
        msa = await deviceCodeLogin();
        saveState({ refreshToken: msa.refresh_token || s.refreshToken });
    }
    const mc = await minecraftLogin(msa.access_token);
    mc.profile = await getProfile(mc.token);
    // Keep the old refresh token if Microsoft didn't rotate it
    saveState({ refreshToken: msa.refresh_token || s.refreshToken });
    return mc;
}

function getRealmsCookie(mc) {
    return (
        "sid=token:" +
        mc.token +
        ":" +
        mc.profile.id +
        "; user=" +
        mc.profile.name +
        "; version=undefined"
    );
}

async function getRealmsInfo(mc) {
    const { status, data: worlds } = await send(
        "https://pc.realms.minecraft.net/worlds",
        {
            headers: { Cookie: getRealmsCookie(mc) },
        },
    );
    if (!worlds.servers)
        throw new Error(
            "Realms Worlds request failed: " + describe(status, worlds),
        );

    const { status: status1, data: players } = await send(
        "https://pc.realms.minecraft.net/activities/liveplayerlist",
        {
            headers: { Cookie: getRealmsCookie(mc) },
        },
    );
    if (!players.lists)
        throw new Error(
            "Realms playerlist request failed: " + describe(status1, players),
        );

    const obj = { worlds: worlds, players: players };
    return obj;
}

// ---------- in-app menu ----------
async function appMenu() {
    if (!Keychain.contains(KC)) return;
    const a = new Alert();
    a.title = "Minecraft widget";
    a.addAction("Preview widget");
    a.addDestructiveAction("Sign out (delete saved tokens)");
    a.addCancelAction("Cancel");
    const choice = await a.present();
    if (choice === 1) {
        Keychain.remove(KC);
        const n = new Alert();
        n.title = "Signed out";
        n.message = "Saved tokens were deleted from this device.";
        n.addAction("OK");
        await n.present();
        Script.complete();
        return "stop";
    }
    if (choice === -1) {
        Script.complete();
        throw new Error("Sign in cancelled");
    }
}

// ---------- widget ----------
async function buildWidget() {
    const w = new ListWidget();
    w.backgroundColor = new Color("#1f2a1a");

    try {
        const mc = await getMinecraftJavaToken();
        const t = w.addText("Your Realms:");
        t.font = Font.boldSystemFont(12);
        t.textColor = Color.white();
        w.addSpacer(4);

        const realms = await getRealmsInfo(mc);
        const { previousActivity } = loadState();
        let currentActivity = {};

        realms.worlds.servers.forEach((world) => {
            const sub = w.addStack();
            const name = sub.addText(world.name);
            const activePlayers = JSON.parse(
                realms.players.lists.find(
                    (server) => server.serverId === world.id,
                )?.playerList || "[]",
            ).length;
            sub.addSpacer();
            const players = sub.addText(
                activePlayers + " / " + world.maxPlayers,
            );
            if (
                NOTIFY &&
                previousActivity?.[world.id] === 0 &&
                activePlayers > 0
            ) {
                console.log("Notify for " + world.name);
                let notif = new Notification();
                notif.title =
                    activePlayers + " player(s) are playing on " + world.name;
                notif.schedule();
            }
            currentActivity[world.id] = activePlayers;
            let color =
                activePlayers >= world.maxPlayers
                    ? SERVER_FULL
                    : activePlayers > 0
                      ? SERVER_OPEN
                      : SERVER_EMPTY;
            name.font = Font.systemFont(12);
            name.textColor = new Color(color);
            players.font = Font.systemFont(12);
            players.textColor = new Color(color);
            w.addSpacer(2);
        });

        w.addSpacer();
        // let now = new Date()
        // w.addText(now.getSeconds().toString())

        let s = loadState();
        s.previousActivity = currentActivity;
        saveState(s);
    } catch (e) {
        const t = w.addText(String(e.message || e).slice(0, 160));
        t.font = Font.systemFont(12);
        t.textColor = new Color("#ff8a80");
    }

    return w;
}

if (config.runsInApp) {
    await appMenu();
}

const widget = await buildWidget();

if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();
Script.complete();
