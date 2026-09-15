#!/usr/bin/env Rscript
suppressPackageStartupMessages(library(jsonlite))
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 1) stop('usage: r_publication_request.R REQUEST_JSON')
req <- fromJSON(args[[1]], simplifyVector=TRUE)
if (!identical(req$backend, 'r_editorial')) stop('request backend must be r_editorial')
inputs <- req$inputs; opt <- req$options
outdir <- req$output_dir; dir.create(outdir, recursive=TRUE, showWarnings=FALSE)
renderer <- ifelse(is.null(opt$renderer), 'publication_map', opt$renderer)
if (renderer == 'editorial_chart') {
  status <- system2('Rscript', c('runtime/gis/r_editorial_chart.R', shQuote(args[[1]])))
} else if (renderer == 'trajectory_map') {
  status <- system2('Rscript', c('runtime/gis/r_trajectory_map.R', shQuote(args[[1]])))
} else if (renderer == 'energy_flow') {
  status <- system2('Rscript', c('runtime/gis/r_energy_flow.R', shQuote(args[[1]])))
} else if (renderer == 'flow_map') {
  status <- system2('Rscript', c('runtime/gis/r_flow_map.R', shQuote(args[[1]])))
} else {
  if (is.null(inputs$track) || is.null(inputs$shoreline)) stop('r_editorial map requires inputs.track and inputs.shoreline')
  out <- file.path(outdir, ifelse(is.null(opt$filename), 'figure.svg', opt$filename))
  status <- system2('Rscript', c('runtime/gis/r_publication_map.R', shQuote(inputs$track), shQuote(inputs$shoreline), shQuote(out)))
}
if (status != 0) quit(status=status)
mp <- file.path(outdir,'manifest.json')
manifest <- if (file.exists(mp)) fromJSON(mp,simplifyVector=FALSE) else list(schema_version='1.0.0',backend='r_editorial')
manifest$artifact_status <- 'FINAL'
manifest$story_id <- req$story_id
manifest$semantic_fingerprint <- req$semantic_fingerprint
manifest$evidence_hashes <- req$evidence_hashes
manifest$claim_ids <- req$claim_ids
manifest$design_system_id <- req$design_system$id
manifest$design_system_hash <- req$design_system$content_hash
writeLines(toJSON(manifest, auto_unbox=TRUE, pretty=TRUE), mp)
