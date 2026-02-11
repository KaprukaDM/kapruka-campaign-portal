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
    
    // Define users - add/remove usernames here
    const users = {
      'manager': env.MANAGER_PASS,
      'developer': env.DEVELOPER_PASS,
      'intern1': env.INTERN1_PASS,
      'intern2': env.INTERN2_PASS,
      'intern3': env.INTERN3_PASS
    };
    
    return users[username] && users[username] === password;
  } catch (e) {
    return false;
  }
}
