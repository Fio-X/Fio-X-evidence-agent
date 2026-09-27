adn_theme <- function(base_size=10) {
  ggplot2::theme_void(base_size=base_size) +
    ggplot2::theme(
      plot.title=ggplot2::element_text(size=18,face='bold',colour='#111111'),
      plot.subtitle=ggplot2::element_text(size=10,colour='#555555'),
      plot.caption=ggplot2::element_text(size=7.5,colour='#666666',hjust=0),
      legend.position='bottom', legend.title=ggplot2::element_text(size=8), legend.text=ggplot2::element_text(size=8)
    )
}
adn_source_note <- function(text) ggplot2::labs(caption=text)
adn_finalise <- function(plot,path,width=11,height=7) ggplot2::ggsave(path,plot,width=width,height=height,device=ifelse(grepl('\\.svg$',path),'svg','pdf'))
