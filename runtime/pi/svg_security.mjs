import { createHash } from 'node:crypto';

export const SVG_SECURITY_VERSION='0.1.0';
export function sha256Text(value){return createHash('sha256').update(String(value??'')).digest('hex');}
export function assertSafeSvg(svg,{label='SVG',maxBytes=5_000_000}={}){
  const value=String(svg??'');
  if(!value.includes('<svg')) throw new Error(`${label} is not SVG`);
  if(!/viewBox\s*=\s*["'][^"']+["']/i.test(value)) throw new Error(`${label} requires a viewBox`);
  if(Buffer.byteLength(value)>maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const forbidden=[
    [/<script\b/i,'script'],
    [/<foreignObject\b/i,'foreignObject'],
    [/\bon\w+\s*=/i,'event handler'],
    [/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|data:|file:|javascript:)/i,'external or active reference'],
    [/<(?:iframe|object|embed|audio|video)\b/i,'active embedded content'],
    [/@import\b/i,'CSS import'],
    [/url\(\s*["']?\s*(?:https?:|\/\/|data:|file:|javascript:)/i,'external CSS URL'],
  ];
  for(const [pattern,reason] of forbidden) if(pattern.test(value)) throw new Error(`${label} contains ${reason}`);
  return value;
}
export function sanitizeSvgAsset(svg,meta={}){
  const clean=assertSafeSvg(svg,{label:meta.label||'SVG'});
  return {svg:clean,sha256:sha256Text(clean),security_version:SVG_SECURITY_VERSION};
}
