import { createHash } from 'node:crypto';

export const SVG_SECURITY_VERSION='0.1.0';
export function sha256Text(value){return createHash('sha256').update(String(value??'')).digest('hex');}
export const SVG_MAX_BYTES=5_000_000;
// [pattern, reason in the refusal, words for the tool description]. assertSafeSvg refuses on this list and nothing else.
export const SVG_FORBIDDEN=Object.freeze([
  [/<script\b/i,'script','script'],
  [/<foreignObject\b/i,'foreignObject','foreignObject'],
  [/\bon\w+\s*=/i,'event handler','event-handler attribute'],
  [/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|data:|file:|javascript:)/i,'external or active reference','href or xlink:href to http, https, //, data, file or javascript'],
  [/<(?:iframe|object|embed|audio|video)\b/i,'active embedded content','iframe, object, embed, audio or video'],
  [/@import\b/i,'CSS import','CSS @import'],
  [/url\(\s*["']?\s*(?:https?:|\/\/|data:|file:|javascript:)/i,'external CSS URL','CSS url() to http, https, //, data, file or javascript'],
]);
export function assertSafeSvg(svg,{label='SVG',maxBytes=SVG_MAX_BYTES}={}){
  const value=String(svg??'');
  if(!value.includes('<svg')) throw new Error(`${label} is not SVG`);
  if(!/viewBox\s*=\s*["'][^"']+["']/i.test(value)) throw new Error(`${label} requires a viewBox`);
  if(Buffer.byteLength(value)>maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  for(const [pattern,reason] of SVG_FORBIDDEN) if(pattern.test(value)) throw new Error(`${label} contains ${reason}`);
  return value;
}
export function sanitizeSvgAsset(svg,meta={}){
  const clean=assertSafeSvg(svg,{label:meta.label||'SVG'});
  return {svg:clean,sha256:sha256Text(clean),security_version:SVG_SECURITY_VERSION};
}
