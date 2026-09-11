// 공지를 올리면 저장된 모든 기기(fcmTokens 컬렉션)로 실제 휴대폰 푸시 알림을 보낸다.
//
// 필요한 설정 (Cloudflare Pages > 프로젝트 > Settings > Environment variables):
//   FIREBASE_SERVICE_ACCOUNT_KEY = Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 >
//     "새 비공개 키 생성"으로 받은 JSON 파일의 내용 전체(문자열 그대로).
//
// npm 패키지 없이 Web Crypto API만으로 Google 서비스 계정 OAuth2 인증을 직접 구현한다
// (Cloudflare Pages Functions 런타임에서 firebase-admin 같은 Node 전용 SDK는 잘 안 돌아간다).

function base64UrlEncode(input) {
  let binary;
  if (typeof input === 'string') {
    binary = input;
  } else {
    const bytes = new Uint8Array(input);
    binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claimSet))}`;

  const pemContents = serviceAccount.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('OAuth 토큰 발급 실패: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

function firestoreValueToJs(value) {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  return null;
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const title = (body.title || '').toString().slice(0, 200);
    const message = (body.body || '').toString().slice(0, 500);
    if (!title) {
      return new Response(JSON.stringify({ error: '제목이 없습니다.' }), { status: 400 });
    }

    const saJson = env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!saJson) {
      return new Response(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT_KEY 환경변수가 설정되지 않았습니다.' }), { status: 500 });
    }
    const serviceAccount = JSON.parse(saJson);
    const projectId = serviceAccount.project_id;
    const accessToken = await getAccessToken(serviceAccount);

    // fcmTokens 컬렉션의 등록된 기기 토큰을 전부 가져온다.
    const listRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/fcmTokens?pageSize=1000`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json();
    const tokens = (listData.documents || [])
      .map(doc => firestoreValueToJs(doc.fields && doc.fields.token))
      .filter(Boolean);

    if (!tokens.length) {
      return new Response(JSON.stringify({ sent: 0, message: '등록된 알림 대상 기기가 없습니다.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let sent = 0;
    const invalidTokens = [];
    // FCM v1은 한 번에 하나씩만 보낼 수 있어서 토큰마다 순서대로 보낸다.
    for (const token of tokens) {
      const sendRes = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body: message },
              webpush: { fcmOptions: { link: '/' } },
            },
          }),
        }
      );
      if (sendRes.ok) {
        sent++;
      } else {
        const errData = await sendRes.json().catch(() => ({}));
        const errCode = errData.error && errData.error.status;
        // 앱을 지웠거나 알림을 껐거나 하면 토큰이 더는 유효하지 않다 — 계속 쌓이지 않게 지운다.
        if (errCode === 'NOT_FOUND' || errCode === 'INVALID_ARGUMENT') {
          invalidTokens.push(token);
        }
      }
    }

    for (const token of invalidTokens) {
      await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/fcmTokens/${token}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
      ).catch(() => {});
    }

    return new Response(JSON.stringify({ sent, total: tokens.length, removedInvalid: invalidTokens.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
