import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MarginCalculator } from './margin-calculator';

describe('MarginCalculator', () => {
  let component: MarginCalculator;
  let fixture: ComponentFixture<MarginCalculator>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MarginCalculator],
    }).compileComponents();

    fixture = TestBed.createComponent(MarginCalculator);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
