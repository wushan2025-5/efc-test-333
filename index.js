const html = `<!DOCTYPE html>
<body>
  <h1>这个返回是edgefunction返回的</h1>
</body>`

async function handleRequest(request) {
  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  })
}

export default {
  async fetch(request) {
    return handleRequest(request);
  }
};
