#!/usr/bin/env Rscript
suppressPackageStartupMessages({library(jsonlite); library(tidygraph); library(ggraph); library(ggplot2); library(ggrepel); library(svglite)})
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 1) stop('usage: r_ggraph.R REQUEST_JSON')
req <- fromJSON(args[[1]], simplifyVector=TRUE)
if (!identical(req$backend, 'ggraph_static')) stop('request backend must be ggraph_static')
src <- req$inputs$table
if (is.null(src)) stop('ggraph_static requires inputs.table')
obj <- fromJSON(src, simplifyDataFrame=TRUE)
rows <- if (!is.null(obj$rows)) obj$rows else obj
opt <- req$options
sf <- ifelse(is.null(opt$source_field),'source',opt$source_field)
tf <- ifelse(is.null(opt$target_field),'target',opt$target_field)
vf <- ifelse(is.null(opt$value_field),'value',opt$value_field)
edges <- data.frame(from=as.character(rows[[sf]]),to=as.character(rows[[tf]]),weight=as.numeric(rows[[vf]]),stringsAsFactors=FALSE)
nodes <- data.frame(name=sort(unique(c(edges$from,edges$to))),stringsAsFactors=FALSE)
edges$from <- match(edges$from,nodes$name); edges$to <- match(edges$to,nodes$name)
g <- tbl_graph(nodes=nodes,edges=edges,directed=TRUE)
set.seed(20260914)
p <- ggraph(g,layout='fr') +
  geom_edge_link(aes(width=weight),alpha=.32,colour='#666666',show.legend=FALSE) +
  geom_node_point(size=3.1,colour='#155f63') +
  geom_node_text(aes(label=name),repel=TRUE,size=3.2,family='sans') +
  scale_edge_width(range=c(.3,2.2)) +
  labs(title=ifelse(is.null(opt$title),'Relationship network',opt$title),caption=ifelse(is.null(opt$source_note),'',opt$source_note)) +
  theme_void(base_size=10) + theme(plot.title=element_text(size=18,face='bold'),plot.caption=element_text(size=7.5,colour='#666666',hjust=0))
outdir <- req$output_dir; dir.create(outdir,recursive=TRUE,showWarnings=FALSE)
out <- file.path(outdir,ifelse(is.null(opt$filename),'figure.svg',opt$filename))
ggsave(out,p,width=11,height=8,device=svglite)
writeLines(toJSON(list(schema_version='1.0.0',backend='ggraph_static',artifact_status='FINAL',story_id=req$story_id,semantic_fingerprint=req$semantic_fingerprint,evidence_hashes=req$evidence_hashes,claim_ids=req$claim_ids,output=out,nodes=nrow(nodes),edges=nrow(edges),layout='fr',seed=20260914),auto_unbox=TRUE,pretty=TRUE),file.path(outdir,'manifest.json'))
