// functions/_middleware.js
export const onRequest = async (context) => {
  const { request, env, next } = context;
  
  // Skip authentication for static assets (CSS, JS, images)
  const url = new URL(request.url);
  if (url.pathname.startsWith('/css/') || 
      url.pathname.startsWith('/js/') || 
      url.pathname.endsWith('.jpg') ||
      url.pathname.endsWith('.png') ||
      url.pathname.endsWith('.ico')) {
    return await next();
  }
  
  // Get authentication header
  const auth = request.headers.get('Authorization');
  
  // Check if user is authenticated
  if (!auth || !isValidUser(auth, env)) {
    return new Response('Authentication Required - Kapruka Campaign Portal', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Kapruka Campaign Portal"',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html'
      }
    });
  }
  
  // User authenticated, proceed to page
  const response = await next();
  response.headers.set('Cache-Control', 'no-store, must-revalidate');
  return response;
};

function isValidUser(authHeader, env) {
  try {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme !== 'Basic') return false;
    
    const decoded = atob(encoded);
    const [username, password] = decoded.split(':');
    
    const users = {
      'aloka': env.ALOKA_PASS,
      'lahiru': env.LAHIRU_PASS,
      'ruwini': env.RUWINI_PASS,
      'iresha': env.IRESHA_PASS,
      'ushara': env.USHARA_PASS,
      'dinesh': env.DINESH_PASS,
      'kaveesha': env.KAVEESHA_PASS,
      'madara': env.MADARA_PASS,
      'ashani': env.ASHANI_PASS,
      'kavindya': env.KAVINDYA_PASS,
      'piumi': env.PIUMI_PASS,
      'sudarson': env.SUDARSON_PASS,
    };
    
    return users[username] && users[username] === password;
  } catch (e) {
    return false;
  }
}
