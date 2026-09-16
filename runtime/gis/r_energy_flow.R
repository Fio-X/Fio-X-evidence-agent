#!/usr/bin/env Rscript
suppressPackageStartupMessages({library(jsonlite); library(ggplot2); library(ggalluvial); library(svglite)})
args <- commandArgs(trailingOnly=TRUE); if(length(args)!=1) stop('usage: r_energy_flow.R REQUEST_JSON')
req <- fromJSON(args[[1]], simplifyVector=TRUE); if(!identical(req$backend,'r_editorial')) stop('request backend must be r_editorial')
src <- req$inputs$table; if(is.null(src)) stop('energy_flow requires inputs.table')
d <- read.csv(src,check.names=FALSE); opt <- req$options
sf <- ifelse(is.null(opt$source_field),'source',opt$source_field); tf <- ifelse(is.null(opt$target_field),'target',opt$target_field); vf <- ifelse(is.null(opt$value_field),'value',opt$value_field)
if(!all(c(sf,tf,vf) %in% names(d))) stop('energy_flow source/target/value fields missing')
# ggalluvial consumes the same directed weighted edge table as ECharts. The two axes are
# categorical stages; no graph geometry is inferred from the order of source rows.
p <- ggplot(d,aes(axis1=.data[[sf]],axis2=.data[[tf]],y=.data[[vf]])) +
  geom_alluvium(aes(fill=.data[[sf]]),alpha=.72,width=1/12,show.legend=FALSE) +
  geom_stratum(width=1/9,fill='#f4f1ea',colour='#77736c',linewidth=.35) +
  geom_text(stat='stratum',aes(label=after_stat(stratum)),size=3.0,colour='#222222') +
  scale_x_discrete(limits=c('Source','Destination'),expand=c(.08,.08)) +
  labs(title=ifelse(is.null(opt$title),'Energy flow',opt$title),subtitle=opt$subtitle,y=ifelse(is.null(opt$y_label),'Flow',opt$y_label),x=NULL,caption=opt$source_note) +
  theme_minimal(base_size=10) + theme(panel.grid.major.x=element_blank(),panel.grid.minor=element_blank(),plot.title=element_text(size=18,face='bold'),plot.caption=element_text(size=7.5,colour='#666666',hjust=0))
outdir <- req$output_dir; dir.create(outdir,recursive=TRUE,showWarnings=FALSE); out <- file.path(outdir,ifelse(is.null(opt$filename),'figure.svg',opt$filename)); ggsave(out,p,width=12,height=7.5,device=svglite)
writeLines(toJSON(list(schema_version='1.0.0',backend='r_editorial',renderer='energy_flow',output=out,rows=nrow(d)),auto_unbox=TRUE,pretty=TRUE),file.path(outdir,'manifest.json'))
