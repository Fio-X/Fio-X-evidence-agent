#!/usr/bin/env Rscript
suppressPackageStartupMessages({library(jsonlite); library(ggplot2); library(svglite)})
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 1) stop('usage: r_editorial_chart.R REQUEST_JSON')
req <- fromJSON(args[[1]], simplifyVector=TRUE); if (!identical(req$backend,'r_editorial')) stop('request backend must be r_editorial')
src <- req$inputs$table; if (is.null(src)) stop('editorial chart requires inputs.table')
d <- if (grepl('\\.csv$',src,ignore.case=TRUE)) read.csv(src,check.names=FALSE) else {x <- fromJSON(src,simplifyDataFrame=TRUE); if (!is.null(x$rows)) x$rows else x}
source('runtime/gis/adnplot.R'); opt <- req$options; tok <- req$design_system$tokens; if (is.null(tok)) tok <- list(); t <- function(k,d) if (is.null(tok[[k]])) d else tok[[k]]; primary<-t('primary','#155f63'); secondary<-t('secondary','#708b8c'); accent<-t('accent','#a84a32'); bg<-t('background','#fbfaf7'); textc<-t('text','#111111'); muted<-t('muted','#666666'); gridc<-t('grid','#ddd9d1'); chart <- ifelse(is.null(opt$chart_type),'line',opt$chart_type)
if (chart == 'line') {
  x <- opt$x_field; y <- opt$y_field; if (is.null(x)||is.null(y)) stop('line chart requires x_field and y_field')
  p <- ggplot(d,aes(x=.data[[x]],y=.data[[y]])) + geom_hline(yintercept=0,linewidth=.3,colour='#b8b5ae') + geom_line(linewidth=.8,colour=primary) + geom_point(size=1.5,colour=primary) + labs(x=ifelse(is.null(opt$x_label),x,opt$x_label),y=ifelse(is.null(opt$y_label),y,opt$y_label))
} else if (chart == 'bar') {
  cat <- opt$category_field; val <- opt$value_field; if (is.null(cat)||is.null(val)) stop('bar chart requires category_field and value_field')
  d[[cat]] <- reorder(as.character(d[[cat]]),d[[val]])
  if (identical(t('bar_mode','bar'),'lollipop')) {
    p <- ggplot(d,aes(x=.data[[val]],y=.data[[cat]])) + geom_segment(aes(x=0,xend=.data[[val]],y=.data[[cat]],yend=.data[[cat]]),linewidth=.55,colour=gridc) + geom_point(size=3,colour=accent)
  } else {
    p <- ggplot(d,aes(x=.data[[val]],y=.data[[cat]])) + geom_col(width=as.numeric(t('bar_height',.62)),fill=secondary)
  }
  if (!is.null(opt$label_field)) p <- p + geom_text(aes(label=paste0(sprintf('%.1f',.data[[val]]),' · ',.data[[opt$label_field]])),hjust=-.08,size=3,colour=textc) + expand_limits(x=max(d[[val]],na.rm=TRUE)*1.20)
  p <- p + labs(x=ifelse(is.null(opt$x_label),val,opt$x_label),y=NULL)
} else if (chart == 'scatter') {
  x <- opt$x_field; y <- opt$y_field; if (is.null(x)||is.null(y)) stop('scatter chart requires x_field and y_field')
  p <- ggplot(d,aes(x=.data[[x]],y=.data[[y]])) + geom_point(size=2.8,colour=primary,alpha=.82)
  if (!is.null(opt$label_field)) p <- p + ggrepel::geom_text_repel(aes(label=.data[[opt$label_field]]),size=2.7,box.padding=.25,max.overlaps=Inf)
  if (!is.null(opt$x_scale) && opt$x_scale == 'log') p <- p + scale_x_log10()
  p <- p + labs(x=ifelse(is.null(opt$x_label),x,opt$x_label),y=ifelse(is.null(opt$y_label),y,opt$y_label))
} else stop(paste('unsupported chart_type',chart))
p <- p + labs(title=ifelse(is.null(opt$title),'Editorial chart',opt$title),subtitle=opt$subtitle,caption=opt$source_note) + theme_minimal(base_size=10) + theme(plot.background=element_rect(fill=bg,colour=NA),panel.background=element_rect(fill=bg,colour=NA),plot.title=element_text(size=as.numeric(t('title_size',18)),face='bold',colour=textc),plot.subtitle=element_text(colour=muted),panel.grid.minor=element_blank(),panel.grid.major=element_line(colour=gridc,linewidth=.25),plot.caption=element_text(size=as.numeric(t('source_size',7.5)),colour=muted,hjust=0))
outdir <- req$output_dir; dir.create(outdir,recursive=TRUE,showWarnings=FALSE); out <- file.path(outdir,ifelse(is.null(opt$filename),'figure.svg',opt$filename)); ggsave(out,p,width=11.5,height=7,device=svglite)
writeLines(toJSON(list(schema_version='1.1.0',design_system_id=req$design_system$id,design_system_hash=req$design_system$content_hash,backend='r_editorial',renderer='editorial_chart',chart_type=chart,output=out,rows=nrow(d)),auto_unbox=TRUE,pretty=TRUE),file.path(outdir,'manifest.json'))
