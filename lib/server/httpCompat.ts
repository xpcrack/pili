/**
 * Web-standard stand-in for next/server's NextRequest / NextResponse.
 * Handlers only used nextUrl.searchParams + .json() / new Response bodies —
 * no cookies, draftMode, or middleware. Dropping the next package.
 */

export class NextRequest extends Request {
  get nextUrl(): URL {
    return new URL(this.url);
  }
}

export class NextResponse extends Response {
  static json(data: unknown, init?: ResponseInit): NextResponse {
    const response = Response.json(data, init);
    return new NextResponse(response.body, response);
  }
}
